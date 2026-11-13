// =============================================================================
// routes/admin/runs.js — Monthly distribution runs: calculate, approve, cancel, pay (FR-6, FR-7, FR-8).
// Mounted under /api/admin by routes/admin/index.js (admins and auditors may
// read; only admins may change things).
// =============================================================================

const express = require('express');
const { db } = require('../../database');
const { audit, distributions, getAdminFeeRate } = require('../../lib/services');
const { isPeriod } = require('../../lib/util/format');
const { adminOnly } = require('./access');

const router = express.Router();

// --- Distribution runs (FR-6, FR-7, FR-8) ----------------------------------------

router.get('/runs', async (req, res) => {
  res.json({ runs: await db.prepare('SELECT * FROM distribution_runs ORDER BY period DESC, created_at DESC').all() });
});

// Create a DRAFT run (calculation only — nothing is paid until it is approved and paid).
router.post('/runs', adminOnly, async (req, res) => {
  const period = isPeriod(req.body.period) ? req.body.period : null;
  if (!period) return res.status(400).json({ message: 'Choose a period (YYYY-MM).' });
  // A second run for the same period throws a ConflictError (HTTP 409).
  const run = await distributions.createDraftRun(period, await getAdminFeeRate(), req.user);
  await audit.append(req.user, 'create_distribution_run', 'distribution_run', run.id,
    { period, pool: run.total_pool, adminFee: run.admin_fee, distributable: run.distributable, held: run.held_amount });
  res.status(201).json({ message: `Draft run ${run.id} calculated for ${period}.`, run });
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
  await distributions.approveRun(req.params.id, req.user); // notifies each rights holder
  await audit.append(req.user, 'approve_distribution_run', 'distribution_run', req.params.id, null);
  res.json({ message: 'Run approved. Rights holders can now see it on their statements.' });
});

router.post('/runs/:id/cancel', adminOnly, async (req, res) => {
  await distributions.cancelRun(req.params.id);
  await audit.append(req.user, 'cancel_distribution_run', 'distribution_run', req.params.id, null);
  res.json({ message: 'Draft run cancelled. You can now recalculate this period.' });
});

// Pay an approved run through the payment gateways (simulated in the prototype).
router.post('/runs/:id/pay', adminOnly, async (req, res) => {
  const { paidHolders, skipped, simulated } = await distributions.payRun(req.params.id);
  await audit.append(req.user, 'pay_distribution_run', 'distribution_run', req.params.id, { paidHolders, skipped, simulated });
  res.json({ message: `Paid ${paidHolders} rights holder(s)${simulated ? ' (simulated)' : ''}.${skipped ? ` ${skipped} have no payout details yet and remain pending.` : ''}` });
});

module.exports = router;
