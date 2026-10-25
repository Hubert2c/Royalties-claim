// =============================================================================
// database.js — database connection, schema and demo data
// -----------------------------------------------------------------------------
// The platform can run on two databases:
//   * SQLite   — default for local development (a single file in ./data)
//   * Postgres — for staging/production (set DATABASE_URL or DB_CLIENT=postgres)
//
// Both are wrapped in the same tiny API so the rest of the code does not care
// which one is in use:
//     await db.prepare(sql).get(...params)   -> first row or null
//     await db.prepare(sql).all(...params)   -> array of rows
//     await db.prepare(sql).run(...params)   -> { changes }
//     await db.exec(sql)                     -> run a script (no params)
// SQL is always written with "?" placeholders; for Postgres they are converted
// to $1, $2, ... automatically.
//
// The tables follow the Entity Relationship Diagram in Chapter 3 of the
// capstone document (Figure 4): RightsHolder, MusicalWork, Recording, Split,
// Licensee, Licence, Tariff, UsageEvent, Payment, DistributionRun,
// RoyaltyLine and AuditLog — plus a few support tables (users, api_keys,
// usage_claims, disputes, settings).
//
// Money is stored as whole Rwandan francs (Rwf) in integer columns. The Rwf has
// no coins in everyday use, and integers avoid floating-point rounding errors
// in royalty calculations.
// =============================================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const usePostgres = !!process.env.DATABASE_URL || String(process.env.DB_CLIENT || '').toLowerCase() === 'postgres';

// Convert "?" placeholders into "$1, $2, ..." for Postgres.
function normalizeParams(sql, params) {
  const flatParams = Array.isArray(params[0]) && params.length === 1 ? params[0] : params;
  let index = 0;
  const normalizedSql = sql.replace(/\?/g, () => `$${++index}`);
  return { sql: normalizedSql, params: flatParams };
}

// -----------------------------------------------------------------------------
// SQLite connection
// We prefer the "better-sqlite3" package. If it is not installed or could not
// be compiled on this machine, we fall back to Node's built-in "node:sqlite"
// module (Node 22.5+), which has an almost identical API.
// -----------------------------------------------------------------------------
function openSqliteFile(dbPath) {
  try {
    const BetterSqlite = require('better-sqlite3');
    return new BetterSqlite(dbPath);
  } catch (error) {
    const { DatabaseSync } = require('node:sqlite');
    return new DatabaseSync(dbPath);
  }
}

function createSqliteDb() {
  const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = process.env.DB_PATH || path.join(dataDir, 'royalty_hub.db');
  const raw = openSqliteFile(dbPath);
  raw.exec('PRAGMA foreign_keys = ON;');

  // Wrap the synchronous SQLite API so callers can always "await" it.
  return {
    kind: 'sqlite',
    prepare(sql) {
      const statement = raw.prepare(sql);
      return {
        async get(...args) { return statement.get(...args) || null; },
        async all(...args) { return statement.all(...args); },
        async run(...args) {
          const result = statement.run(...args);
          return { changes: Number(result.changes || 0) };
        }
      };
    },
    async exec(sql) { raw.exec(sql); },
    close() { raw.close(); }
  };
}

// -----------------------------------------------------------------------------
// Postgres connection (pg Pool)
// -----------------------------------------------------------------------------
function createPostgresDb() {
  const pg = require('pg');
  // BIGINT (OID 20) comes back as a string by default; our amounts fit safely
  // in a JavaScript number, so convert them to numbers.
  pg.types.setTypeParser(20, (value) => parseInt(value, 10));

  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/royalty_hub',
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
  });

  return {
    kind: 'postgres',
    prepare(sql) {
      return {
        async get(...args) {
          const q = normalizeParams(sql, args);
          const result = await pool.query(q.sql, q.params);
          return result.rows[0] || null;
        },
        async all(...args) {
          const q = normalizeParams(sql, args);
          const result = await pool.query(q.sql, q.params);
          return result.rows;
        },
        async run(...args) {
          const q = normalizeParams(sql, args);
          const result = await pool.query(q.sql, q.params);
          return { changes: Number(result.rowCount || 0) };
        }
      };
    },
    async exec(sql) { await pool.query(sql); },
    close() { return pool.end(); }
  };
}

const db = usePostgres ? createPostgresDb() : createSqliteDb();

// -----------------------------------------------------------------------------
// Schema — written in SQL that both SQLite and Postgres accept.
// All primary keys are text IDs generated by the application (see newId()).
// -----------------------------------------------------------------------------
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL,                 -- admin | auditor | rightsholder | licensee
  created_at TEXT NOT NULL
);

-- RightsHolder: songwriters, composers, publishers and performers.
CREATE TABLE IF NOT EXISTS rights_holders (
  id TEXT PRIMARY KEY,
  user_id TEXT UNIQUE REFERENCES users(id),
  full_name TEXT NOT NULL,
  ipi_number TEXT,                    -- Interested Party Information number
  holder_type TEXT NOT NULL,          -- writer | composer | publisher | performer
  payout_method TEXT,                 -- momo | bank
  payout_ref_encrypted TEXT,          -- phone/account, encrypted at rest (lib/crypto-box.js)
  payout_ref_last4 TEXT,              -- shown in the UI instead of the full number
  status TEXT NOT NULL,               -- active | suspended
  created_at TEXT NOT NULL
);

-- MusicalWork: the composition (lyrics + melody), identified by an ISWC.
CREATE TABLE IF NOT EXISTS works (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  iswc TEXT,
  status TEXT NOT NULL,               -- pending_splits | active
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL
);

-- Recording: a sound recording of a work, identified by an ISRC.
-- "fingerprint" holds a Chromaprint raw fingerprint (comma-separated 32-bit integers).
CREATE TABLE IF NOT EXISTS recordings (
  id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL REFERENCES works(id),
  title TEXT NOT NULL,
  performer TEXT,
  isrc TEXT,
  duration_sec INTEGER,
  fingerprint TEXT,
  created_at TEXT NOT NULL
);

-- Split: the share of a work owed to one rights holder. Must total 100% per work.
CREATE TABLE IF NOT EXISTS splits (
  id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL REFERENCES works(id),
  holder_id TEXT NOT NULL REFERENCES rights_holders(id),
  share_percent REAL NOT NULL,
  right_type TEXT NOT NULL,           -- lyrics | music | publishing | performance
  status TEXT NOT NULL,               -- pending | confirmed | rejected
  confirmed_at TEXT,
  created_at TEXT NOT NULL
);

-- Licensee: anyone who uses music commercially.
CREATE TABLE IF NOT EXISTS licensees (
  id TEXT PRIMARY KEY,
  user_id TEXT UNIQUE REFERENCES users(id),
  name TEXT NOT NULL,
  category TEXT NOT NULL,             -- radio | tv | event | advertiser | venue | telecom | digital
  tin TEXT,                           -- RRA tax identification number
  rura_licence_no TEXT,               -- broadcasting licence number (radio/tv)
  created_at TEXT NOT NULL
);

-- Tariff: the price list set by the royalty ministerial order.
CREATE TABLE IF NOT EXISTS tariffs (
  id TEXT PRIMARY KEY,
  usage_type TEXT NOT NULL,           -- same values as licensees.category
  name TEXT NOT NULL,
  basis TEXT NOT NULL,                -- flat_annual | percent_gross | per_ad | per_event
  rate REAL NOT NULL,                 -- Rwf amount, or a percentage for percent_gross
  legal_reference TEXT,
  status TEXT NOT NULL,               -- draft | approved | retired
  approved_by TEXT,
  created_at TEXT NOT NULL
);

-- Licence: permission for one licensee for one period, priced by a tariff.
CREATE TABLE IF NOT EXISTS licences (
  id TEXT PRIMARY KEY,
  licensee_id TEXT NOT NULL REFERENCES licensees(id),
  tariff_id TEXT NOT NULL REFERENCES tariffs(id),
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  quantity INTEGER,                   -- number of ads/events for per_ad / per_event tariffs
  gross_amount BIGINT,                -- declared gross receipts for percent_gross tariffs
  fee_due BIGINT NOT NULL,
  status TEXT NOT NULL,               -- applied | invoiced | paid | rejected
  clearance_code TEXT,                -- issued on approval; checked by broadcasters/permits
  description TEXT,
  created_at TEXT NOT NULL
);

-- Payment: money received for a licence (simulated mobile money / bank in the prototype).
CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  licence_id TEXT NOT NULL REFERENCES licences(id),
  amount BIGINT NOT NULL,
  channel TEXT NOT NULL,              -- momo | bank | irembo
  reference TEXT NOT NULL,
  paid_at TEXT NOT NULL
);

-- UsageEvent: one use of a recording (a radio play, a song in a set list, an ad...).
CREATE TABLE IF NOT EXISTS usage_events (
  id TEXT PRIMARY KEY,
  licensee_id TEXT REFERENCES licensees(id),
  recording_id TEXT REFERENCES recordings(id),
  source TEXT NOT NULL,               -- fingerprint | play_log | set_list | cue_sheet | ddex | simulation
  raw_title TEXT,
  raw_artist TEXT,
  isrc TEXT,
  played_at TEXT NOT NULL,
  period TEXT NOT NULL,               -- YYYY-MM, used to group usage into distribution runs
  duration_sec INTEGER,
  confidence REAL,
  status TEXT NOT NULL,               -- matched | unmatched
  created_at TEXT NOT NULL
);

-- DistributionRun: one royalty distribution for a period (draft -> approved -> paid).
CREATE TABLE IF NOT EXISTS distribution_runs (
  id TEXT PRIMARY KEY,
  period TEXT NOT NULL,
  total_pool BIGINT NOT NULL,
  admin_fee_rate REAL NOT NULL,
  admin_fee BIGINT NOT NULL,
  distributable BIGINT NOT NULL,
  held_amount BIGINT NOT NULL,        -- money for works whose splits are not yet confirmed
  usage_count INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_by TEXT,
  approved_by TEXT,
  created_at TEXT NOT NULL,
  approved_at TEXT,
  paid_at TEXT
);

-- RoyaltyLine: money owed to one rights holder for one usage event in one run.
-- Linking every line to its usage event is what makes each payment traceable.
CREATE TABLE IF NOT EXISTS royalty_lines (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES distribution_runs(id),
  holder_id TEXT REFERENCES rights_holders(id),   -- NULL when the money is held
  usage_id TEXT NOT NULL REFERENCES usage_events(id),
  work_id TEXT NOT NULL REFERENCES works(id),
  share_percent REAL,
  usage_value BIGINT NOT NULL,        -- value of the whole usage event
  amount BIGINT NOT NULL,             -- this holder's part of it
  paid_status TEXT NOT NULL,          -- pending | paid | held
  payout_reference TEXT
);

-- Claims on unmatched ("black box") usage by rights holders.
CREATE TABLE IF NOT EXISTS usage_claims (
  id TEXT PRIMARY KEY,
  usage_id TEXT NOT NULL REFERENCES usage_events(id),
  claimant_user_id TEXT NOT NULL REFERENCES users(id),
  recording_id TEXT NOT NULL REFERENCES recordings(id),
  note TEXT,
  evidence_file TEXT,
  status TEXT NOT NULL,               -- pending | approved | rejected
  decided_by TEXT,
  decided_at TEXT,
  created_at TEXT NOT NULL
);

-- Disputes raised by rights holders or licensees.
CREATE TABLE IF NOT EXISTS disputes (
  id TEXT PRIMARY KEY,
  raised_by TEXT NOT NULL REFERENCES users(id),
  subject_type TEXT NOT NULL,         -- split | statement | licence | usage | other
  subject_id TEXT,
  reason TEXT NOT NULL,
  status TEXT NOT NULL,               -- open | resolved | rejected
  resolution TEXT,
  resolved_by TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL
);

-- AuditLog: append-only and hash-chained (see lib/audit.js).
CREATE TABLE IF NOT EXISTS audit_log (
  seq INTEGER PRIMARY KEY,
  actor_id TEXT,
  actor_role TEXT,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT,
  details TEXT,
  created_at TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);

-- API keys for the open API (broadcast playout systems, monitoring services...).
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  owner_type TEXT NOT NULL,           -- licensee | monitor
  owner_id TEXT,                      -- licensee id (NULL for a national monitor)
  label TEXT NOT NULL,
  key_prefix TEXT NOT NULL,           -- first characters, shown in the UI
  key_hash TEXT NOT NULL,             -- sha256 of the full key; the key itself is never stored
  revoked INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

-- In-app notifications (the bell in every portal).
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  body TEXT,
  view TEXT,                          -- which portal view to open when clicked
  is_read INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

-- Simple key/value settings (e.g. the administration fee rate).
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

// Short, readable unique IDs such as "WRK-9F3A1C2B".
function newId(prefix) {
  return `${prefix}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

function nowIso() {
  return new Date().toISOString();
}

// -----------------------------------------------------------------------------
// Demo data, so the prototype can be shown straight away.
// All organisation names below are fictional.
// Tariff amounts are DEMO VALUES — the real figures come from the 2026
// ministerial order on royalties. The venue figure (Rwf 150,000 per year for
// 0–2 star hotels) is the 2017 RDB tariff cited in the capstone document.
// -----------------------------------------------------------------------------
async function seedDemoData() {
  const existing = await db.prepare('SELECT 1 AS found FROM users LIMIT 1').get();
  if (existing) return; // already seeded

  // Load these lazily to avoid circular requires at start-up.
  const { encrypt } = require('./lib/crypto-box');
  const { syntheticFingerprint } = require('./lib/fingerprint');
  const { appendAudit } = require('./lib/audit');
  const created = nowIso();

  // --- Users --------------------------------------------------------------
  const users = [
    ['user-admin', 'RIPO Administrator', 'admin@royaltyhub.com', 'admin123', 'admin'],
    ['user-auditor', 'Independent Auditor', 'auditor@royaltyhub.com', 'auditor123', 'auditor'],
    ['user-artist', 'Munezero Hubert', 'artist@royaltyhub.com', 'artist123', 'rightsholder'],
    ['user-cowriter', 'Aline Kay', 'cowriter@royaltyhub.com', 'artist123', 'rightsholder'],
    ['user-radio', 'Inkingi FM (demo)', 'radio@royaltyhub.com', 'licensee123', 'licensee'],
    ['user-venue', 'Hotel Akagera View (demo)', 'venue@royaltyhub.com', 'licensee123', 'licensee']
  ];
  for (const [id, name, email, password, role] of users) {
    await db.prepare('INSERT INTO users (id, name, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, name, email, bcrypt.hashSync(password, 10), role, created);
  }

  // --- Rights holders -----------------------------------------------------
  const holders = [
    ['RH-HUBERT', 'user-artist', 'Munezero Hubert', '00512345678', 'writer', 'momo', '0788123456'],
    ['RH-ALINE', 'user-cowriter', 'Aline Kay', '00598765432', 'composer', 'momo', '0722987654']
  ];
  for (const [id, userId, name, ipi, type, method, ref] of holders) {
    await db.prepare(`INSERT INTO rights_holders (id, user_id, full_name, ipi_number, holder_type, payout_method,
        payout_ref_encrypted, payout_ref_last4, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, userId, name, ipi, type, method, encrypt(ref), ref.slice(-4), 'active', created);
  }

  // --- Works, recordings and splits ---------------------------------------
  const works = [
    { id: 'WRK-MIDNIGHT', title: 'Midnight Echo', iswc: 'T-123.456.789-0', rec: 'REC-MIDNIGHT', isrc: 'RWA012600001', performer: 'Munezero Hubert', seed: 11,
      splits: [['RH-HUBERT', 60, 'lyrics'], ['RH-ALINE', 40, 'music']] },
    { id: 'WRK-GOLDEN', title: 'Golden Hours', iswc: 'T-987.654.321-0', rec: 'REC-GOLDEN', isrc: 'RWA012600002', performer: 'Aline Kay', seed: 22,
      splits: [['RH-ALINE', 100, 'music']] },
    { id: 'WRK-CITY', title: 'City Lights', iswc: 'T-555.444.333-0', rec: 'REC-CITY', isrc: 'RWA012600003', performer: 'Munezero Hubert', seed: 33,
      // Aline has not confirmed yet — royalties for this work are HELD until she does.
      splits: [['RH-HUBERT', 50, 'lyrics'], ['RH-ALINE', 50, 'music', 'pending']] }
  ];
  for (const work of works) {
    const allConfirmed = work.splits.every((s) => s[3] !== 'pending');
    await db.prepare('INSERT INTO works (id, title, iswc, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(work.id, work.title, work.iswc, allConfirmed ? 'active' : 'pending_splits', 'user-artist', created);
    await db.prepare(`INSERT INTO recordings (id, work_id, title, performer, isrc, duration_sec, fingerprint, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(work.rec, work.id, work.title, work.performer, work.isrc, 210, syntheticFingerprint(work.seed, 240).join(','), created);
    for (const [holderId, share, rightType, status = 'confirmed'] of work.splits) {
      await db.prepare(`INSERT INTO splits (id, work_id, holder_id, share_percent, right_type, status, confirmed_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(newId('SPL'), work.id, holderId, share, rightType, status, status === 'confirmed' ? created : null, created);
    }
  }

  // --- Licensees ----------------------------------------------------------
  await db.prepare('INSERT INTO licensees (id, user_id, name, category, tin, rura_licence_no, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('LIC-RADIO', 'user-radio', 'Inkingi FM (demo)', 'radio', '101234567', 'RURA/BR/2026/014', created);
  await db.prepare('INSERT INTO licensees (id, user_id, name, category, tin, rura_licence_no, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('LIC-VENUE', 'user-venue', 'Hotel Akagera View (demo)', 'venue', '107654321', null, created);

  // --- Tariffs (DEMO VALUES — replace with the ministerial order figures) ---
  const tariffs = [
    ['TRF-RADIO', 'radio', 'Commercial radio – annual blanket licence', 'flat_annual', 1200000],
    ['TRF-TV', 'tv', 'Television – annual blanket licence', 'flat_annual', 1500000],
    ['TRF-EVENT', 'event', 'Concerts and live events – % of gross receipts', 'percent_gross', 5],
    ['TRF-AD', 'advertiser', 'Advertisement (sync) – per advert', 'per_ad', 50000],
    ['TRF-VENUE', 'venue', 'Hotels & restaurants 0–2 star – annual (2017 RDB tariff)', 'flat_annual', 150000],
    ['TRF-TELECOM', 'telecom', 'Caller tunes / telecom – % of gross receipts', 'percent_gross', 10],
    ['TRF-DIGITAL', 'digital', 'Digital & streaming services – % of gross receipts', 'percent_gross', 8]
  ];
  for (const [id, type, name, basis, rate] of tariffs) {
    await db.prepare(`INSERT INTO tariffs (id, usage_type, name, basis, rate, legal_reference, status, approved_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, type, name, basis, rate, 'Ministerial Order on royalties (2026) — demo value', 'approved', 'user-admin', created);
  }

  // --- A paid radio licence for the current year --------------------------
  const year = new Date().getUTCFullYear();
  const period = new Date().toISOString().slice(0, 7);
  await db.prepare(`INSERT INTO licences (id, licensee_id, tariff_id, period_start, period_end, quantity, gross_amount,
      fee_due, status, clearance_code, description, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('LCN-RADIO', 'LIC-RADIO', 'TRF-RADIO', `${year}-01-01`, `${year}-12-31`, null, null, 1200000, 'paid', 'CLR-RADIO-DEMO', 'Annual broadcast licence', created);
  await db.prepare('INSERT INTO payments (id, licence_id, amount, channel, reference, paid_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('PAY-DEMO1', 'LCN-RADIO', 1200000, 'momo', 'MOMO-DEMO-0001', created);

  // The hotel has applied but not paid yet (shows up in the compliance view).
  await db.prepare(`INSERT INTO licences (id, licensee_id, tariff_id, period_start, period_end, quantity, gross_amount,
      fee_due, status, clearance_code, description, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('LCN-VENUE', 'LIC-VENUE', 'TRF-VENUE', `${year}-01-01`, `${year}-12-31`, null, null, 150000, 'invoiced', 'CLR-VENUE-DEMO', 'Background music licence', created);

  // --- Usage events for this month ----------------------------------------
  const plays = [
    ['REC-MIDNIGHT', 'fingerprint', 0.94], ['REC-MIDNIGHT', 'fingerprint', 0.91], ['REC-MIDNIGHT', 'play_log', null],
    ['REC-GOLDEN', 'fingerprint', 0.89], ['REC-GOLDEN', 'play_log', null],
    ['REC-CITY', 'fingerprint', 0.87]
  ];
  for (let i = 0; i < plays.length; i += 1) {
    const [recordingId, source, confidence] = plays[i];
    const rec = await db.prepare('SELECT * FROM recordings WHERE id = ?').get(recordingId);
    const playedAt = new Date(Date.now() - (i + 1) * 3600 * 1000).toISOString();
    await db.prepare(`INSERT INTO usage_events (id, licensee_id, recording_id, source, raw_title, raw_artist, isrc, played_at,
        period, duration_sec, confidence, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(newId('USE'), 'LIC-RADIO', recordingId, source, rec.title, rec.performer, rec.isrc, playedAt, period, 210, confidence, 'matched', created);
  }
  // One play that matches nothing registered — it goes to the public "unclaimed" list.
  await db.prepare(`INSERT INTO usage_events (id, licensee_id, recording_id, source, raw_title, raw_artist, isrc, played_at,
      period, duration_sec, confidence, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('USE-UNMATCHED1', 'LIC-RADIO', null, 'play_log', 'Urukundo Rwacu', 'Unknown artist', null, created, period, 195, null, 'unmatched', created);

  await db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('admin_fee_rate', '0.15');

  // --- Five past months of history, so the charts have something to show ---
  // Each month: an advert campaign licence paid by the radio station, some plays,
  // and a distribution run calculated by the REAL royalty engine, approved and paid.
  const { createDraftRun } = require('./lib/royalty-engine');
  const history = [
    { monthsAgo: 5, campaign: 6, plays: ['REC-MIDNIGHT', 'REC-GOLDEN', 'REC-MIDNIGHT', 'REC-GOLDEN', 'REC-MIDNIGHT'] },
    { monthsAgo: 4, campaign: 8, plays: ['REC-MIDNIGHT', 'REC-GOLDEN', 'REC-GOLDEN', 'REC-MIDNIGHT', 'REC-CITY', 'REC-MIDNIGHT'] },
    { monthsAgo: 3, campaign: 7, plays: ['REC-GOLDEN', 'REC-MIDNIGHT', 'REC-GOLDEN', 'REC-MIDNIGHT', 'REC-MIDNIGHT'] },
    { monthsAgo: 2, campaign: 10, plays: ['REC-MIDNIGHT', 'REC-MIDNIGHT', 'REC-GOLDEN', 'REC-CITY', 'REC-MIDNIGHT', 'REC-GOLDEN', 'REC-MIDNIGHT'] },
    { monthsAgo: 1, campaign: 12, plays: ['REC-MIDNIGHT', 'REC-GOLDEN', 'REC-MIDNIGHT', 'REC-GOLDEN', 'REC-MIDNIGHT', 'REC-CITY', 'REC-GOLDEN', 'REC-MIDNIGHT'] }
  ];
  for (const month of history) {
    const day = new Date();
    day.setUTCDate(10);
    day.setUTCMonth(day.getUTCMonth() - month.monthsAgo);
    const iso = day.toISOString();
    const monthKey = iso.slice(0, 7);
    const licenceId = `LCN-ADS-${monthKey.replace('-', '')}`;
    const fee = 50000 * month.campaign;

    await db.prepare(`INSERT INTO licences (id, licensee_id, tariff_id, period_start, period_end, quantity, gross_amount,
        fee_due, status, clearance_code, description, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(licenceId, 'LIC-RADIO', 'TRF-AD', `${monthKey}-01`, `${monthKey}-28`, month.campaign, null, fee, 'paid',
        `CLR-${monthKey.replace('-', '')}`, `Advert campaign ${monthKey}`, iso);
    await db.prepare('INSERT INTO payments (id, licence_id, amount, channel, reference, paid_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(newId('PAY'), licenceId, fee, 'momo', `MOMO-DEMO-${monthKey}`, iso);

    for (let i = 0; i < month.plays.length; i += 1) {
      const rec = await db.prepare('SELECT * FROM recordings WHERE id = ?').get(month.plays[i]);
      const playedAt = new Date(day.getTime() + i * 86400000).toISOString();
      await db.prepare(`INSERT INTO usage_events (id, licensee_id, recording_id, source, raw_title, raw_artist, isrc, played_at,
          period, duration_sec, confidence, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(newId('USE'), 'LIC-RADIO', rec.id, i % 3 === 2 ? 'play_log' : 'fingerprint', rec.title, rec.performer, rec.isrc, playedAt,
          monthKey, 210, i % 3 === 2 ? null : 0.9, 'matched', playedAt);
    }

    const run = await createDraftRun(db, monthKey, 0.15, { id: 'user-admin', role: 'admin' });
    await db.prepare("UPDATE distribution_runs SET status = 'paid', approved_by = 'user-admin', approved_at = ?, paid_at = ? WHERE id = ?").run(iso, iso, run.id);
    await db.prepare("UPDATE royalty_lines SET paid_status = 'paid', payout_reference = ? WHERE run_id = ? AND paid_status = 'pending'").run(`MOMO-DEMO-${monthKey}`, run.id);
  }

  // A few demo notifications so the bell is not empty on the first visit.
  const demoNotes = [
    ['user-cowriter', 'Confirm your share of "City Lights"', 'Munezero Hubert listed you at 50% (music). Royalties are held until you confirm.', 'confirm'],
    ['user-admin', 'Hotel Akagera View has an unpaid invoice', 'Rwf 150,000 for the background music licence is still unpaid.', 'compliance'],
    ['user-venue', 'Your licence invoice is ready', 'Pay Rwf 150,000 to activate clearance code CLR-VENUE-DEMO.', 'licences']
  ];
  for (const [userId, title, body, view] of demoNotes) {
    await db.prepare('INSERT INTO notifications (id, user_id, title, body, view, is_read, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(newId('NTF'), userId, title, body, view, 0, created);
  }

  await appendAudit(db, { id: 'system', role: 'system' }, 'seed', 'database', null, { note: 'Demo data loaded' });
}

async function initializeDatabase() {
  // SQLite accepts the whole script at once; Postgres also accepts multiple
  // statements in one query when there are no parameters.
  await db.exec(SCHEMA);
  if (process.env.SKIP_SEED !== 'true') {
    await seedDemoData();
  }
}

module.exports = { db, initializeDatabase, newId, nowIso };
