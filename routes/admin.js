// =============================================================================
// routes/admin.js — API for the Government administration console
// -----------------------------------------------------------------------------
// "admin"   (Rwanda Intellectual Property Office) can read AND change things.
// "auditor" (independent auditor / Parliament) can only READ.
//
// Covers functional requirements:
//   FR-3  approve licences (issue invoices and clearance codes)
//   FR-5  airplay detection (incl. a "simulate airplay" demo)
//   FR-6  calculate royalties per period
//   FR-7  approve tariffs, licences and distribution runs before payment
//   FR-8  pay out (simulated) and produce statements
//   FR-9  decide claims on unmatched usage
//   FR-10 resolve disputes
//   FR-11 audit log (with hash-chain verification)
//   FR-13 API keys for monitors
// Plus the compliance view from the flowchart (Figure 7): who used music
// without a paid licence.
// =============================================================================

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, newId, nowIso } = require('../database');
const { authRequired, requireRole, generateApiKey } = require('../lib/auth');
const { appendAudit, verifyAuditChain } = require('../lib/audit');
const { BASES, CATEGORIES } = require('../lib/tariffs');
const { recordUsage } = require('../lib/usage');
const { parseFingerprint, noisySample } = require('../lib/fingerprint');
const { createDraftRun, MAX_ADMIN_FEE_RATE } = require('../lib/royalty-engine');
const { notifyUsers, notifyHolders, rwf } = require('../lib/notify');
const { lastMonths, fillMonths } = require('../lib/periods');

const router = express.Router();
router.use(authRequired, requireRole('admin', 'auditor'));

// Write operations: admin only.
const adminOnly = requireRole('admin');

const currentPeriod = () => new Date().toISOString().slice(0, 7);
const isPeriod = (value) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(value || ''));

async function getAdminFeeRate() {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'admin_fee_rate'").get();
  return row ? Number(row.value) : 0.15;
}

// --- Overview --------------------------------------------------------------------

router.get('/overview', async (req, res) => {
  const one = async (sql, ...params) => Number(Object.values(await db.prepare(sql).get(...params))[0] || 0);
  const period = currentPeriod();

  const overview = {
    period,
    collectedTotal: await one('SELECT COALESCE(SUM(amount), 0) AS v FROM payments'),
    collectedThisPeriod: await one('SELECT COALESCE(SUM(amount), 0) AS v FROM payments WHERE substr(paid_at, 1, 7) = ?', period),
    distributedPaid: await one("SELECT COALESCE(SUM(amount), 0) AS v FROM royalty_lines rl JOIN distribution_runs r ON r.id = rl.run_id WHERE rl.paid_status = 'paid' AND r.status <> 'cancelled'"),
    adminFees: await one("SELECT COALESCE(SUM(admin_fee), 0) AS v FROM distribution_runs WHERE status IN ('approved', 'paid')"),
    heldAmount: await one("SELECT COALESCE(SUM(held_amount), 0) AS v FROM distribution_runs WHERE status IN ('approved', 'paid')"),
    worksCount: await one('SELECT COUNT(*) AS v FROM works'),
    activeWorks: await one("SELECT COUNT(*) AS v FROM works WHERE status = 'active'"),
    holdersCount: await one('SELECT COUNT(*) AS v FROM rights_holders'),
    licenseesCount: await one('SELECT COUNT(*) AS v FROM licensees'),
    pendingLicences: await one("SELECT COUNT(*) AS v FROM licences WHERE status = 'applied'"),
    unpaidInvoices: await one("SELECT COUNT(*) AS v FROM licences WHERE status = 'invoiced'"),
    pendingClaims: await one("SELECT COUNT(*) AS v FROM usage_claims WHERE status = 'pending'"),
    openDisputes: await one("SELECT COUNT(*) AS v FROM disputes WHERE status = 'open'"),
    usageThisPeriod: await one('SELECT COUNT(*) AS v FROM usage_events WHERE period = ?', period),
    unmatchedUsage: await one("SELECT COUNT(*) AS v FROM usage_events WHERE status = 'unmatched'"),
    adminFeeRate: await getAdminFeeRate()
  };
  overview.usageBySource = await db.prepare('SELECT source, COUNT(*) AS count FROM usage_events WHERE period = ? GROUP BY source ORDER BY count DESC').all(period);
  overview.recentAudit = await db.prepare('SELECT seq, actor_role, action, entity, entity_id, created_at FROM audit_log ORDER BY seq DESC LIMIT 8').all();
  return res.json({ overview });
});

// --- Charts, live feed and search -----------------------------------------------

// GET /api/admin/trends — last 12 months of collections, payouts and plays (for the charts)
router.get('/trends', async (req, res) => {
  const months = lastMonths(12);
  const first = months[0];
  const collections = await db.prepare(`SELECT substr(paid_at, 1, 7) AS period, SUM(amount) AS value FROM payments
    WHERE substr(paid_at, 1, 7) >= ? GROUP BY substr(paid_at, 1, 7)`).all(first);
  const payouts = await db.prepare(`SELECT r.period AS period, SUM(rl.amount) AS value FROM royalty_lines rl JOIN distribution_runs r ON r.id = rl.run_id
    WHERE rl.paid_status = 'paid' AND r.period >= ? GROUP BY r.period`).all(first);
  const plays = await db.prepare('SELECT period, COUNT(*) AS value FROM usage_events WHERE period >= ? GROUP BY period').all(first);
  res.json({ months, collections: fillMonths(months, collections), payouts: fillMonths(months, payouts), plays: fillMonths(months, plays) });
});

// GET /api/admin/live — the latest detected / reported plays (polled every few seconds)
router.get('/live', async (req, res) => {
  const plays = await db.prepare(`
    SELECT u.id, u.played_at, u.created_at, u.source, u.confidence, u.status, u.raw_title, u.raw_artist,
      rec.title AS recording_title, rec.performer, l.name AS licensee_name, l.category
    FROM usage_events u LEFT JOIN recordings rec ON rec.id = u.recording_id LEFT JOIN licensees l ON l.id = u.licensee_id
    ORDER BY u.created_at DESC, u.played_at DESC LIMIT 12
  `).all();
  res.json({ plays });
});

// GET /api/admin/search?q=... — quick search (Ctrl+K) across the registry
router.get('/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ results: [] });
  const like = `%${q.toLowerCase()}%`;
  const results = [];
  const add = (rows, type, view, toLabel) => rows.forEach((row) => results.push({ type, view, id: row.id, ...toLabel(row) }));

  add(await db.prepare('SELECT id, title, iswc, status FROM works WHERE lower(title) LIKE ? OR lower(iswc) LIKE ? LIMIT 5').all(like, like),
    'Work', 'catalogue', (w) => ({ title: w.title, detail: `${w.iswc || 'No ISWC'}, ${w.status.replace('_', ' ')}` }));
  add(await db.prepare('SELECT r.id, r.title, r.isrc, r.performer FROM recordings r WHERE lower(r.isrc) LIKE ? OR lower(r.performer) LIKE ? LIMIT 5').all(like, like),
    'Recording', 'catalogue', (r) => ({ title: r.title, detail: `${r.performer || ''} ${r.isrc || ''}`.trim() }));
  add(await db.prepare('SELECT id, full_name, ipi_number, holder_type FROM rights_holders WHERE lower(full_name) LIKE ? OR lower(ipi_number) LIKE ? LIMIT 5').all(like, like),
    'Rights holder', 'catalogue', (h) => ({ title: h.full_name, detail: `${h.holder_type}${h.ipi_number ? `, IPI ${h.ipi_number}` : ''}` }));
  add(await db.prepare('SELECT id, name, category, tin FROM licensees WHERE lower(name) LIKE ? OR lower(tin) LIKE ? LIMIT 5').all(like, like),
    'Licensee', 'licences', (l) => ({ title: l.name, detail: `${l.category}${l.tin ? `, TIN ${l.tin}` : ''}` }));
  add(await db.prepare('SELECT id, period, status, distributable FROM distribution_runs WHERE lower(id) LIKE ? OR period LIKE ? LIMIT 5').all(like, like),
    'Distribution run', 'runs', (r) => ({ title: `${r.id} (${r.period})`, detail: `${r.status}, ${rwf(r.distributable)} for creators` }));
  add(await db.prepare('SELECT id, clearance_code, status, fee_due FROM licences WHERE lower(clearance_code) LIKE ? OR lower(id) LIKE ? LIMIT 5').all(like, like),
    'Licence', 'licences', (l) => ({ title: l.clearance_code || l.id, detail: `${l.status}, ${rwf(l.fee_due)}` }));
  res.json({ results });
});

// --- Tariffs (FR-7) ----------------------------------------------------------------

router.get('/tariffs', async (req, res) => {
  res.json({ tariffs: await db.prepare('SELECT * FROM tariffs ORDER BY status, usage_type, name').all() });
});

router.post('/tariffs', adminOnly, async (req, res) => {
  const { usageType, name, basis, rate, legalReference } = req.body || {};
  if (!CATEGORIES.includes(usageType)) return res.status(400).json({ message: 'Choose a valid usage type.' });
  if (!BASES.includes(basis)) return res.status(400).json({ message: 'Choose a valid basis.' });
  if (!name || !Number.isFinite(Number(rate)) || Number(rate) <= 0) return res.status(400).json({ message: 'Name and a positive rate are required.' });
  if (basis === 'percent_gross' && Number(rate) > 100) return res.status(400).json({ message: 'A percentage rate cannot be above 100.' });

  const id = newId('TRF');
  await db.prepare('INSERT INTO tariffs (id, usage_type, name, basis, rate, legal_reference, status, approved_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, usageType, String(name).trim(), basis, Number(rate), legalReference ? String(legalReference).trim() : null, 'draft', null, nowIso());
  await appendAudit(db, req.user, 'create_tariff', 'tariff', id, { usageType, basis, rate: Number(rate) });
  res.status(201).json({ message: 'Tariff saved as draft. Approve it to make it available to licensees.', id });
});

router.post('/tariffs/:id/:decision', adminOnly, async (req, res) => {
  const { decision } = req.params;
  const newStatus = { approve: 'approved', retire: 'retired' }[decision];
  if (!newStatus) return res.status(404).json({ message: 'Unknown action.' });
  const result = await db.prepare('UPDATE tariffs SET status = ?, approved_by = ? WHERE id = ?').run(newStatus, req.user.id, req.params.id);
  if (!result.changes) return res.status(404).json({ message: 'Tariff not found.' });
  await appendAudit(db, req.user, `${decision}_tariff`, 'tariff', req.params.id, null);
  res.json({ message: `Tariff ${newStatus}.` });
});

// --- Licensees & licences (FR-3, FR-7) -------------------------------------------

router.get('/licensees', async (req, res) => {
  const licensees = await db.prepare(`
    SELECT l.*, u.email,
      (SELECT COUNT(*) FROM licences x WHERE x.licensee_id = l.id AND x.status = 'paid') AS paid_licences,
      (SELECT COUNT(*) FROM usage_events e WHERE e.licensee_id = l.id) AS usage_count
    FROM licensees l LEFT JOIN users u ON u.id = l.user_id ORDER BY l.name
  `).all();
  res.json({ licensees });
});

router.get('/licences', async (req, res) => {
  const licences = await db.prepare(`
    SELECT l.*, li.name AS licensee_name, li.category, t.name AS tariff_name, t.basis, t.rate
    FROM licences l JOIN licensees li ON li.id = l.licensee_id JOIN tariffs t ON t.id = l.tariff_id
    ORDER BY CASE l.status WHEN 'applied' THEN 0 WHEN 'invoiced' THEN 1 ELSE 2 END, l.created_at DESC
  `).all();
  res.json({ licences });
});

router.post('/licences/:id/:decision', adminOnly, async (req, res) => {
  const { decision } = req.params;
  if (!['approve', 'reject'].includes(decision)) return res.status(404).json({ message: 'Unknown action.' });
  const licence = await db.prepare('SELECT * FROM licences WHERE id = ?').get(req.params.id);
  if (!licence) return res.status(404).json({ message: 'Licence not found.' });
  if (licence.status !== 'applied') return res.status(409).json({ message: `This licence is already ${licence.status}.` });

  if (decision === 'approve') {
    // The clearance code is what a broadcaster or permit office checks before an ad airs / an event goes ahead.
    const code = `CLR-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    await db.prepare("UPDATE licences SET status = 'invoiced', clearance_code = ? WHERE id = ?").run(code, licence.id);
    await appendAudit(db, req.user, 'approve_licence', 'licence', licence.id, { fee: licence.fee_due, clearance: code });
    const owner = await db.prepare('SELECT user_id FROM licensees WHERE id = ?').get(licence.licensee_id);
    await notifyUsers(owner && owner.user_id, 'Your licence is approved — invoice ready', `Pay ${rwf(licence.fee_due)} to activate clearance code ${code}.`, 'licences');
    return res.json({ message: `Licence approved and invoiced. Clearance code ${code} will be valid once paid.` });
  }
  await db.prepare("UPDATE licences SET status = 'rejected' WHERE id = ?").run(licence.id);
  await appendAudit(db, req.user, 'reject_licence', 'licence', licence.id, { reason: req.body.reason || null });
  const owner = await db.prepare('SELECT user_id FROM licensees WHERE id = ?').get(licence.licensee_id);
  await notifyUsers(owner && owner.user_id, 'Your licence application was rejected', 'Contact the Rwanda Intellectual Property Office or raise a dispute.', 'licences');
  return res.json({ message: 'Licence application rejected.' });
});

// --- Catalogue ------------------------------------------------------------------

router.get('/works', async (req, res) => {
  const works = await db.prepare(`
    SELECT w.*, (SELECT COUNT(*) FROM recordings r WHERE r.work_id = w.id) AS recordings,
      (SELECT COUNT(*) FROM usage_events u JOIN recordings r ON r.id = u.recording_id WHERE r.work_id = w.id) AS plays
    FROM works w ORDER BY w.created_at DESC
  `).all();
  for (const work of works) {
    work.splits = await db.prepare(`SELECT h.full_name, s.share_percent, s.right_type, s.status FROM splits s
      JOIN rights_holders h ON h.id = s.holder_id WHERE s.work_id = ? AND s.status <> 'rejected'`).all(work.id);
  }
  res.json({ works });
});

router.get('/rights-holders', async (req, res) => {
  res.json({ holders: await db.prepare('SELECT id, full_name, ipi_number, holder_type, payout_method, payout_ref_last4, status, created_at FROM rights_holders ORDER BY full_name').all() });
});

// --- Usage & monitoring (FR-4, FR-5) ---------------------------------------------

router.get('/usage', async (req, res) => {
  const period = isPeriod(req.query.period) ? req.query.period : currentPeriod();
  const status = ['matched', 'unmatched'].includes(req.query.status) ? req.query.status : null;
  const usage = await db.prepare(`
    SELECT u.*, rec.title AS recording_title, l.name AS licensee_name FROM usage_events u
    LEFT JOIN recordings rec ON rec.id = u.recording_id LEFT JOIN licensees l ON l.id = u.licensee_id
    WHERE u.period = ? ${status ? 'AND u.status = ?' : ''} ORDER BY u.played_at DESC LIMIT 500
  `).all(...(status ? [period, status] : [period]));
  res.json({ usage, period });
});

// POST /api/admin/usage/simulate  Body: { licenseeId, count }
// DEMO ONLY: imitates a radio monitor. It takes a few seconds of a registered
// song's fingerprint, adds noise (like a real radio signal), and sends it
// through the SAME matching code that real monitor data uses.
router.post('/usage/simulate', adminOnly, async (req, res) => {
  const licensee = await db.prepare('SELECT * FROM licensees WHERE id = ?').get(req.body.licenseeId);
  if (!licensee) return res.status(400).json({ message: 'Choose a station to simulate.' });
  const count = Math.min(Math.max(Number(req.body.count) || 3, 1), 20);

  const catalogue = await db.prepare('SELECT id, fingerprint FROM recordings WHERE fingerprint IS NOT NULL').all();
  if (!catalogue.length) return res.status(400).json({ message: 'No recordings with fingerprints are registered yet.' });

  const rows = [];
  for (let i = 0; i < count; i += 1) {
    const pick = catalogue[Math.floor(Math.random() * catalogue.length)];
    const fingerprint = parseFingerprint(pick.fingerprint);
    const start = Math.floor(Math.random() * Math.max(fingerprint.length - 60, 1));
    rows.push({ fingerprint: noisySample(fingerprint, start, 60, 4), played_at: new Date().toISOString(), duration_sec: 210 });
  }

  const summary = await recordUsage({ licenseeId: licensee.id, source: 'simulation', rows });
  await appendAudit(db, req.user, 'simulate_airplay', 'usage_events', null, { station: licensee.id, count, matched: summary.matched });
  res.status(201).json({ message: `Simulated ${count} plays on ${licensee.name}: ${summary.matched} identified by fingerprint.`, summary });
});

// Compliance: licensees with usage this period but no paid licence covering it (Figure 7: "Licence fee paid?").
router.get('/compliance', async (req, res) => {
  const period = isPeriod(req.query.period) ? req.query.period : currentPeriod();
  const day = `${period}-15`; // a date in the middle of the period
  const rows = await db.prepare(`
    SELECT l.id, l.name, l.category, l.tin,
      (SELECT COUNT(*) FROM usage_events u WHERE u.licensee_id = l.id AND u.period = ?) AS usage_count,
      (SELECT COUNT(*) FROM licences x WHERE x.licensee_id = l.id AND x.status = 'paid' AND x.period_start <= ? AND x.period_end >= ?) AS paid_cover,
      (SELECT COUNT(*) FROM licences x WHERE x.licensee_id = l.id AND x.status = 'invoiced') AS unpaid_invoices,
      (SELECT COALESCE(SUM(fee_due), 0) FROM licences x WHERE x.licensee_id = l.id AND x.status = 'invoiced') AS amount_owed
    FROM licensees l ORDER BY l.name
  `).all(period, day, day);

  const compliance = rows.map((row) => {
    let status = 'compliant';
    if (Number(row.usage_count) > 0 && Number(row.paid_cover) === 0) status = 'unlicensed_use';
    else if (Number(row.unpaid_invoices) > 0) status = 'invoice_unpaid';
    else if (Number(row.paid_cover) === 0) status = 'no_licence';
    return { ...row, status };
  });
  res.json({ compliance, period });
});

// Record that a reminder / legal notice was sent (no email is sent in the prototype).
router.post('/compliance/:licenseeId/remind', adminOnly, async (req, res) => {
  const licensee = await db.prepare('SELECT * FROM licensees WHERE id = ?').get(req.params.licenseeId);
  if (!licensee) return res.status(404).json({ message: 'Licensee not found.' });
  const level = req.body.level === 'legal_notice' ? 'legal_notice' : 'reminder';
  await appendAudit(db, req.user, `send_${level}`, 'licensee', licensee.id, { name: licensee.name });
  res.json({ message: `${level === 'legal_notice' ? 'Legal notice' : 'Reminder'} recorded for ${licensee.name}.` });
});

// --- Claims on unmatched usage (FR-9) --------------------------------------------

router.get('/claims', async (req, res) => {
  const claims = await db.prepare(`
    SELECT c.*, u.raw_title, u.raw_artist, u.played_at, u.period, u.source, l.name AS licensee_name,
      rec.title AS recording_title, rec.isrc, us.name AS claimant_name
    FROM usage_claims c JOIN usage_events u ON u.id = c.usage_id JOIN recordings rec ON rec.id = c.recording_id
    LEFT JOIN licensees l ON l.id = u.licensee_id JOIN users us ON us.id = c.claimant_user_id
    ORDER BY CASE c.status WHEN 'pending' THEN 0 ELSE 1 END, c.created_at DESC
  `).all();
  res.json({ claims });
});

// Download a claim's evidence file (admin & auditor only — evidence is not public).
router.get('/claims/:id/evidence', async (req, res) => {
  const claim = await db.prepare('SELECT evidence_file FROM usage_claims WHERE id = ?').get(req.params.id);
  if (!claim || !claim.evidence_file) return res.status(404).json({ message: 'No evidence file.' });
  const uploadDir = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads'));
  const filePath = path.join(uploadDir, path.basename(claim.evidence_file));
  if (!fs.existsSync(filePath)) return res.status(404).json({ message: 'File is missing on the server.' });
  return res.download(filePath);
});

router.post('/claims/:id/:decision', adminOnly, async (req, res) => {
  const { decision } = req.params;
  if (!['approve', 'reject'].includes(decision)) return res.status(404).json({ message: 'Unknown action.' });
  const claim = await db.prepare('SELECT * FROM usage_claims WHERE id = ?').get(req.params.id);
  if (!claim) return res.status(404).json({ message: 'Claim not found.' });
  if (claim.status !== 'pending') return res.status(409).json({ message: `Claim already ${claim.status}.` });

  if (decision === 'approve') {
    const usage = await db.prepare('SELECT * FROM usage_events WHERE id = ?').get(claim.usage_id);
    if (usage.status !== 'unmatched') return res.status(409).json({ message: 'This usage was already matched by another claim.' });

    // If the usage's period has already been distributed, move it to the first
    // period that has not been distributed yet, so it is paid in the next run.
    let period = usage.period;
    const run = await db.prepare("SELECT status FROM distribution_runs WHERE period = ? AND status <> 'cancelled'").get(period);
    if (run && run.status !== 'draft') {
      period = currentPeriod();
      while (await db.prepare("SELECT 1 AS found FROM distribution_runs WHERE period = ? AND status IN ('approved', 'paid')").get(period)) {
        const next = new Date(`${period}-01T00:00:00Z`);
        next.setUTCMonth(next.getUTCMonth() + 1);
        period = next.toISOString().slice(0, 7);
      }
    }
    await db.prepare("UPDATE usage_events SET recording_id = ?, status = 'matched', period = ? WHERE id = ?").run(claim.recording_id, period, usage.id);
    // Any other pending claims on the same usage are rejected automatically.
    await db.prepare("UPDATE usage_claims SET status = 'rejected', decided_by = ?, decided_at = ? WHERE usage_id = ? AND id <> ? AND status = 'pending'")
      .run(req.user.id, nowIso(), usage.id, claim.id);
  }
  await db.prepare('UPDATE usage_claims SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?')
    .run(decision === 'approve' ? 'approved' : 'rejected', req.user.id, nowIso(), claim.id);
  await appendAudit(db, req.user, `${decision}_usage_claim`, 'usage_claim', claim.id, { usage: claim.usage_id, recording: claim.recording_id });
  await notifyUsers(claim.claimant_user_id, decision === 'approve' ? 'Your claim was approved' : 'Your claim was rejected',
    decision === 'approve' ? 'The play is now matched to your song and will be paid in the next distribution run.' : 'You can raise a dispute if you disagree.', 'unclaimed');
  res.json({ message: decision === 'approve' ? 'Claim approved. The usage is now matched and will be included in the next distribution run.' : 'Claim rejected.' });
});

// --- Disputes (FR-10) ------------------------------------------------------------

router.get('/disputes', async (req, res) => {
  const disputes = await db.prepare(`SELECT d.*, u.name AS raised_by_name, u.role AS raised_by_role FROM disputes d
    JOIN users u ON u.id = d.raised_by ORDER BY CASE d.status WHEN 'open' THEN 0 ELSE 1 END, d.created_at DESC`).all();
  res.json({ disputes });
});

router.post('/disputes/:id/resolve', adminOnly, async (req, res) => {
  const status = req.body.status === 'rejected' ? 'rejected' : 'resolved';
  const resolution = String(req.body.resolution || '').trim();
  if (!resolution) return res.status(400).json({ message: 'Please write the decision / resolution.' });
  const result = await db.prepare("UPDATE disputes SET status = ?, resolution = ?, resolved_by = ?, resolved_at = ? WHERE id = ? AND status = 'open'")
    .run(status, resolution.slice(0, 1000), req.user.id, nowIso(), req.params.id);
  if (!result.changes) return res.status(404).json({ message: 'Open dispute not found.' });
  await appendAudit(db, req.user, 'resolve_dispute', 'dispute', req.params.id, { status });
  const dispute = await db.prepare('SELECT raised_by FROM disputes WHERE id = ?').get(req.params.id);
  await notifyUsers(dispute && dispute.raised_by, `Your dispute was ${status}`, resolution.slice(0, 200), 'disputes');
  res.json({ message: `Dispute ${status}.` });
});

// --- Distribution runs (FR-6, FR-7, FR-8) ----------------------------------------

router.get('/runs', async (req, res) => {
  res.json({ runs: await db.prepare('SELECT * FROM distribution_runs ORDER BY period DESC, created_at DESC').all() });
});

// Create a DRAFT run (calculation only — nothing is paid until it is approved and paid).
router.post('/runs', adminOnly, async (req, res) => {
  const period = isPeriod(req.body.period) ? req.body.period : null;
  if (!period) return res.status(400).json({ message: 'Choose a period (YYYY-MM).' });
  try {
    const run = await createDraftRun(db, period, await getAdminFeeRate(), req.user);
    await appendAudit(db, req.user, 'create_distribution_run', 'distribution_run', run.id,
      { period, pool: run.total_pool, adminFee: run.admin_fee, distributable: run.distributable, held: run.held_amount });
    res.status(201).json({ message: `Draft run ${run.id} calculated for ${period}.`, run });
  } catch (error) {
    res.status(409).json({ message: error.message });
  }
});

// Run details: totals per rights holder and per work, plus the held lines.
router.get('/runs/:id', async (req, res) => {
  const run = await db.prepare('SELECT * FROM distribution_runs WHERE id = ?').get(req.params.id);
  if (!run) return res.status(404).json({ message: 'Run not found.' });
  const byHolder = await db.prepare(`
    SELECT h.id, h.full_name, h.payout_method, h.payout_ref_last4, COUNT(*) AS lines, SUM(rl.amount) AS amount,
      SUM(CASE WHEN rl.paid_status = 'paid' THEN rl.amount ELSE 0 END) AS paid
    FROM royalty_lines rl JOIN rights_holders h ON h.id = rl.holder_id
    WHERE rl.run_id = ? GROUP BY h.id, h.full_name, h.payout_method, h.payout_ref_last4 ORDER BY amount DESC
  `).all(run.id);
  const byWork = await db.prepare(`
    SELECT w.title, w.status, COUNT(DISTINCT rl.usage_id) AS plays, SUM(rl.amount) AS amount,
      SUM(CASE WHEN rl.paid_status = 'held' THEN rl.amount ELSE 0 END) AS held
    FROM royalty_lines rl JOIN works w ON w.id = rl.work_id WHERE rl.run_id = ? GROUP BY w.id, w.title, w.status ORDER BY amount DESC
  `).all(run.id);
  res.json({ run, byHolder, byWork });
});

router.post('/runs/:id/approve', adminOnly, async (req, res) => {
  const result = await db.prepare("UPDATE distribution_runs SET status = 'approved', approved_by = ?, approved_at = ? WHERE id = ? AND status = 'draft'")
    .run(req.user.id, nowIso(), req.params.id);
  if (!result.changes) return res.status(409).json({ message: 'Only a draft run can be approved.' });
  await appendAudit(db, req.user, 'approve_distribution_run', 'distribution_run', req.params.id, null);
  // Tell each rights holder how much they will receive.
  const totals = await db.prepare(`SELECT rl.holder_id, SUM(rl.amount) AS amount, r.period FROM royalty_lines rl JOIN distribution_runs r ON r.id = rl.run_id
    WHERE rl.run_id = ? AND rl.holder_id IS NOT NULL GROUP BY rl.holder_id, r.period`).all(req.params.id);
  for (const t of totals) {
    await notifyHolders(t.holder_id, `Royalties for ${t.period} approved: ${rwf(t.amount)}`, 'Your statement is ready. Payment follows shortly.', 'statements');
  }
  res.json({ message: 'Run approved. Rights holders can now see it on their statements.' });
});

router.post('/runs/:id/cancel', adminOnly, async (req, res) => {
  const result = await db.prepare("UPDATE distribution_runs SET status = 'cancelled' WHERE id = ? AND status = 'draft'").run(req.params.id);
  if (!result.changes) return res.status(409).json({ message: 'Only a draft run can be cancelled.' });
  await appendAudit(db, req.user, 'cancel_distribution_run', 'distribution_run', req.params.id, null);
  res.json({ message: 'Draft run cancelled. You can now recalculate this period.' });
});

// Pay an approved run — SIMULATED payouts to each rights holder's mobile money / bank.
router.post('/runs/:id/pay', adminOnly, async (req, res) => {
  const run = await db.prepare('SELECT * FROM distribution_runs WHERE id = ?').get(req.params.id);
  if (!run || run.status !== 'approved') return res.status(409).json({ message: 'Only an approved run can be paid.' });

  const holders = await db.prepare(`SELECT DISTINCT h.id, h.payout_ref_last4, h.payout_method FROM royalty_lines rl
    JOIN rights_holders h ON h.id = rl.holder_id WHERE rl.run_id = ? AND rl.paid_status = 'pending'`).all(run.id);

  let paidHolders = 0;
  let skipped = 0;
  for (const holder of holders) {
    if (!holder.payout_ref_last4) { skipped += 1; continue; } // no payout details yet: stays pending
    const reference = `${String(holder.payout_method || 'momo').toUpperCase()}-SIM-${run.id.slice(-4)}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
    const due = await db.prepare("SELECT COALESCE(SUM(amount), 0) AS amount FROM royalty_lines WHERE run_id = ? AND holder_id = ? AND paid_status = 'pending'").get(run.id, holder.id);
    await db.prepare("UPDATE royalty_lines SET paid_status = 'paid', payout_reference = ? WHERE run_id = ? AND holder_id = ? AND paid_status = 'pending'")
      .run(reference, run.id, holder.id);
    await notifyHolders(holder.id, `${rwf(due.amount)} sent to your ${holder.payout_method === 'bank' ? 'bank account' : 'mobile money'}`,
      `Royalties for ${run.period}. Reference ${reference}.`, 'statements');
    paidHolders += 1;
  }

  const stillPending = Number((await db.prepare("SELECT COUNT(*) AS n FROM royalty_lines WHERE run_id = ? AND paid_status = 'pending'").get(run.id)).n);
  if (stillPending === 0) {
    await db.prepare("UPDATE distribution_runs SET status = 'paid', paid_at = ? WHERE id = ?").run(nowIso(), run.id);
  }
  await appendAudit(db, req.user, 'pay_distribution_run', 'distribution_run', run.id, { paidHolders, skipped, simulated: true });
  res.json({ message: `Paid ${paidHolders} rights holder(s) (simulated).${skipped ? ` ${skipped} have no payout details yet and remain pending.` : ''}` });
});

// --- Audit log (FR-11) -----------------------------------------------------------

router.get('/audit', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  const entries = await db.prepare(`SELECT a.*, u.name AS actor_name FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
    ORDER BY a.seq DESC LIMIT ${limit}`).all();
  res.json({ entries });
});

router.get('/audit/verify', async (req, res) => {
  res.json({ verification: await verifyAuditChain(db) });
});

// --- Settings ----------------------------------------------------------------------

router.get('/settings', async (req, res) => {
  res.json({ adminFeeRate: await getAdminFeeRate(), maxAdminFeeRate: MAX_ADMIN_FEE_RATE });
});

router.put('/settings', adminOnly, async (req, res) => {
  const rate = Number(req.body.adminFeeRate);
  if (!Number.isFinite(rate) || rate < 0 || rate > MAX_ADMIN_FEE_RATE) {
    return res.status(400).json({ message: `The administration fee must be between 0% and ${MAX_ADMIN_FEE_RATE * 100}%.` });
  }
  const existing = await db.prepare("SELECT 1 AS found FROM settings WHERE key = 'admin_fee_rate'").get();
  if (existing) await db.prepare("UPDATE settings SET value = ? WHERE key = 'admin_fee_rate'").run(String(rate));
  else await db.prepare("INSERT INTO settings (key, value) VALUES ('admin_fee_rate', ?)").run(String(rate));
  await appendAudit(db, req.user, 'update_admin_fee_rate', 'settings', 'admin_fee_rate', { rate });
  res.json({ message: `Administration fee set to ${(rate * 100).toFixed(1)}%.` });
});

// --- API keys for monitoring services (FR-13) -------------------------------------

router.get('/api-keys', async (req, res) => {
  res.json({ keys: await db.prepare('SELECT k.id, k.owner_type, k.owner_id, k.label, k.key_prefix, k.revoked, k.created_at, l.name AS licensee_name FROM api_keys k LEFT JOIN licensees l ON l.id = k.owner_id ORDER BY k.created_at DESC').all() });
});

router.post('/api-keys', adminOnly, async (req, res) => {
  const label = String(req.body.label || 'National radio monitor').slice(0, 80);
  const { key, prefix, hash } = generateApiKey();
  const id = newId('KEY');
  await db.prepare('INSERT INTO api_keys (id, owner_type, owner_id, label, key_prefix, key_hash, revoked, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, 'monitor', null, label, prefix, hash, 0, nowIso());
  await appendAudit(db, req.user, 'create_api_key', 'api_key', id, { label, type: 'monitor' });
  res.status(201).json({ message: 'Monitor API key created. Copy it now — it will not be shown again.', key, id });
});

router.post('/api-keys/:id/revoke', adminOnly, async (req, res) => {
  const result = await db.prepare('UPDATE api_keys SET revoked = 1 WHERE id = ?').run(req.params.id);
  if (!result.changes) return res.status(404).json({ message: 'Key not found.' });
  await appendAudit(db, req.user, 'revoke_api_key', 'api_key', req.params.id, null);
  res.json({ message: 'API key revoked.' });
});

module.exports = router;
