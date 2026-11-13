// =============================================================================
// routes/admin/usage.js — Usage events, simulated airplay and compliance (FR-4, FR-5).
// Mounted under /api/admin by routes/admin/index.js (admins and auditors may
// read; only admins may change things).
// =============================================================================

const express = require('express');
const { db } = require('../../database');
const { FingerprintMatcher } = require('../../lib/fingerprint/FingerprintMatcher');
const { DemoFingerprints } = require('../../lib/fingerprint/DemoFingerprints');
const { audit, usage: usageService } = require('../../lib/services');
const { isPeriod, currentPeriod } = require('../../lib/util/format');
const { adminOnly } = require('./access');

const router = express.Router();

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
    const fingerprint = FingerprintMatcher.parse(pick.fingerprint);
    const start = Math.floor(Math.random() * Math.max(fingerprint.length - 60, 1));
    rows.push({ fingerprint: DemoFingerprints.noisySample(fingerprint, start, 60, 4), played_at: new Date().toISOString(), duration_sec: 210 });
  }

  const summary = await usageService.record({ licenseeId: licensee.id, source: 'simulation', rows });
  await audit.append(req.user, 'simulate_airplay', 'usage_events', null, { station: licensee.id, count, matched: summary.matched });
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
  await audit.append(req.user, `send_${level}`, 'licensee', licensee.id, { name: licensee.name });
  res.json({ message: `${level === 'legal_notice' ? 'Legal notice' : 'Reminder'} recorded for ${licensee.name}.` });
});

module.exports = router;
