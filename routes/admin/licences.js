// =============================================================================
// routes/admin/licences.js — Licensees, licence decisions (FR-3, FR-7) and the catalogue of works.
// Mounted under /api/admin by routes/admin/index.js (admins and auditors may
// read; only admins may change things).
// =============================================================================

const express = require('express');
const { db } = require('../../database');
const { audit, licensing, notifications } = require('../../lib/services');
const { rwf } = require('../../lib/util/format');
const { adminOnly } = require('./access');

const router = express.Router();

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
  const { licence, code } = await licensing.decide(req.params.id, req.params.decision);
  const owner = await db.prepare('SELECT user_id FROM licensees WHERE id = ?').get(licence.licensee_id);
  if (code) {
    await audit.append(req.user, 'approve_licence', 'licence', licence.id, { fee: licence.fee_due, clearance: code });
    await notifications.notifyUsers(owner && owner.user_id, 'Your licence is approved — invoice ready', `Pay ${rwf(licence.fee_due)} to activate clearance code ${code}.`, 'licences');
    return res.json({ message: `Licence approved and invoiced. Clearance code ${code} will be valid once paid.` });
  }
  await audit.append(req.user, 'reject_licence', 'licence', licence.id, { reason: req.body.reason || null });
  await notifications.notifyUsers(owner && owner.user_id, 'Your licence application was rejected', 'Contact the Rwanda Intellectual Property Office or raise a dispute.', 'licences');
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

module.exports = router;
