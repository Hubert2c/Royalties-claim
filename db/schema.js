// =============================================================================
// db/schema.js — the tables, written in SQL that both SQLite and Postgres accept
// -----------------------------------------------------------------------------
// The tables follow the Entity Relationship Diagram in Chapter 3 of the capstone
// document (Figure 4): RightsHolder, MusicalWork, Recording, Split, Licensee,
// Licence, Tariff, UsageEvent, Payment, DistributionRun, RoyaltyLine and
// AuditLog — plus support tables (users, api_keys, usage_claims, disputes,
// notifications, settings): 18 tables in total.
//
// Money is stored as whole Rwandan francs in integer columns: integers avoid
// floating-point rounding errors in royalty calculations.
// All primary keys are text IDs made by the application (see newId()).
// =============================================================================

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
  payout_ref_encrypted TEXT,          -- phone/account, encrypted at rest (lib/security/FieldEncryptor.js)
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
-- Indexes (added after the load test showed dashboard queries slowing down as
-- the usage table grew): every column used to filter, join or sort large tables.
CREATE INDEX IF NOT EXISTS idx_usage_status ON usage_events (status);
CREATE INDEX IF NOT EXISTS idx_usage_period_status ON usage_events (period, status);
CREATE INDEX IF NOT EXISTS idx_usage_period_source ON usage_events (period, source);
CREATE INDEX IF NOT EXISTS idx_usage_licensee_period ON usage_events (licensee_id, period);
CREATE INDEX IF NOT EXISTS idx_usage_recording ON usage_events (recording_id);
CREATE INDEX IF NOT EXISTS idx_usage_played_at ON usage_events (played_at);
CREATE INDEX IF NOT EXISTS idx_lines_run ON royalty_lines (run_id, paid_status);
CREATE INDEX IF NOT EXISTS idx_lines_holder ON royalty_lines (holder_id);
CREATE INDEX IF NOT EXISTS idx_lines_usage ON royalty_lines (usage_id);
CREATE INDEX IF NOT EXISTS idx_splits_work ON splits (work_id);
CREATE INDEX IF NOT EXISTS idx_splits_holder ON splits (holder_id);
CREATE INDEX IF NOT EXISTS idx_recordings_work ON recordings (work_id);
CREATE INDEX IF NOT EXISTS idx_recordings_isrc ON recordings (isrc);
CREATE INDEX IF NOT EXISTS idx_licences_licensee ON licences (licensee_id, status);
CREATE INDEX IF NOT EXISTS idx_licences_clearance ON licences (clearance_code);
CREATE INDEX IF NOT EXISTS idx_payments_licence ON payments (licence_id);
CREATE INDEX IF NOT EXISTS idx_payments_paid_at ON payments (paid_at);
CREATE INDEX IF NOT EXISTS idx_runs_period ON distribution_runs (period, status);
CREATE INDEX IF NOT EXISTS idx_claims_status ON usage_claims (status);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications (user_id, is_read);
`;

module.exports = { SCHEMA };
