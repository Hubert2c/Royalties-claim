// =============================================================================
// routes/disputes.js — rights holders and licensees raise disputes (FR-10)
// -----------------------------------------------------------------------------
// The government administrator resolves them in the console (routes/admin.js).
// =============================================================================

const express = require('express');
const { db, newId, nowIso } = require('../database');
const { authRequired, requireRole } = require('../lib/auth');
const { appendAudit } = require('../lib/audit');
const { notifyRoles } = require('../lib/notify');

const router = express.Router();
router.use(authRequired, requireRole('rightsholder', 'licensee'));

const SUBJECTS = ['split', 'statement', 'licence', 'usage', 'other'];

// GET /api/disputes — my disputes
router.get('/', async (req, res) => {
  const disputes = await db.prepare('SELECT * FROM disputes WHERE raised_by = ? ORDER BY created_at DESC').all(req.user.id);
  res.json({ disputes });
});

// POST /api/disputes  Body: { subjectType, subjectId, reason }
router.post('/', async (req, res) => {
  const { subjectType, subjectId, reason } = req.body || {};
  if (!SUBJECTS.includes(subjectType)) return res.status(400).json({ message: 'Choose what the dispute is about.' });
  if (!reason || String(reason).trim().length < 10) return res.status(400).json({ message: 'Please explain the problem (at least 10 characters).' });

  const id = newId('DSP');
  await db.prepare('INSERT INTO disputes (id, raised_by, subject_type, subject_id, reason, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, req.user.id, subjectType, subjectId ? String(subjectId).trim().slice(0, 60) : null, String(reason).trim().slice(0, 1000), 'open', nowIso());
  await appendAudit(db, req.user, 'raise_dispute', 'dispute', id, { subjectType, subjectId: subjectId || null });
  await notifyRoles(['admin'], `New dispute from ${req.user.name}`, String(reason).trim().slice(0, 140), 'claims');
  res.status(201).json({ message: 'Dispute submitted. You will see the decision here.', id });
});

module.exports = router;
