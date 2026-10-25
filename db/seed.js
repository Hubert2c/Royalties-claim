// =============================================================================
// db/seed.js — demo data, so the prototype can be shown straight away
// -----------------------------------------------------------------------------
// Loaded on the first start (unless SKIP_SEED=true). Passwords are hashed with
// bcrypt, payout numbers encrypted, and five months of history are calculated
// by the REAL royalty engine so the charts have something to show.
// =============================================================================

const bcrypt = require('bcryptjs');
const { fieldEncryptor } = require('../lib/security/FieldEncryptor');
const { DemoFingerprints } = require('../lib/fingerprint/DemoFingerprints');
const { AuditLog } = require('../lib/audit/AuditLog');
const { DistributionService } = require('../lib/royalties/DistributionService');

// -----------------------------------------------------------------------------
// Demo data, so the prototype can be shown straight away.
// All organisation names below are fictional.
// Tariff amounts are DEMO VALUES — the real figures come from the 2026
// ministerial order on royalties. The venue figure (Rwf 150,000 per year for
// 0–2 star hotels) is the 2017 RDB tariff cited in the capstone document.
// -----------------------------------------------------------------------------
async function seedDemoData({ db, newId, nowIso }) {
  const existing = await db.prepare('SELECT 1 AS found FROM users LIMIT 1').get();
  if (existing) return; // already seeded

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
      .run(id, userId, name, ipi, type, method, fieldEncryptor.encrypt(ref), ref.slice(-4), 'active', created);
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
      .run(work.rec, work.id, work.title, work.performer, work.isrc, 210, DemoFingerprints.synthetic(work.seed, 240).join(','), created);
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
  const distributions = new DistributionService({ db, newId, nowIso });
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

    const run = await distributions.createDraftRun(monthKey, 0.15, { id: 'user-admin', role: 'admin' });
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

  await new AuditLog(db).append({ id: 'system', role: 'system' }, 'seed', 'database', null, { note: 'Demo data loaded' });
}

module.exports = { seedDemoData };
