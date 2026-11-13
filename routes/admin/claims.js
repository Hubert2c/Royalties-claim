// =============================================================================
// routes/admin/claims.js — Claims on unmatched plays (FR-9) and disputes (FR-10).
// Mounted under /api/admin by routes/admin/index.js (admins and auditors may
// read; only admins may change things).
// =============================================================================

const express = require('express');
const fs = require('fs');
const path = require('path');
const { db, nowIso } = require('../../database');
const { audit, notifications } = require('../../lib/services');
const { currentPeriod } = require('../../lib/util/format');
const { adminOnly } = require('./access');

const router = express.Router();

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
  const uploadDir = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, '..', '..', 'uploads'));
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
  await audit.append(req.user, `${decision}_usage_claim`, 'usage_claim', claim.id, { usage: claim.usage_id, recording: claim.recording_id });
  await notifications.notifyUsers(claim.claimant_user_id, decision === 'approve' ? 'Your claim was approved' : 'Your claim was rejected',
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
  await audit.append(req.user, 'resolve_dispute', 'dispute', req.params.id, { status });
  const dispute = await db.prepare('SELECT raised_by FROM disputes WHERE id = ?').get(req.params.id);
  await notifications.notifyUsers(dispute && dispute.raised_by, `Your dispute was ${status}`, resolution.slice(0, 200), 'disputes');
  res.json({ message: `Dispute ${status}.` });
});

module.exports = router;
