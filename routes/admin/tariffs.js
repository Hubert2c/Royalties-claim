// =============================================================================
// routes/admin/tariffs.js — Tariffs: create, approve and retire (FR-7).
// Mounted under /api/admin by routes/admin/index.js (admins and auditors may
// read; only admins may change things).
// =============================================================================

const express = require('express');
const { db, newId, nowIso } = require('../../database');
const { BASES, CATEGORIES } = require('../../lib/tariffs/TariffRules');
const { audit } = require('../../lib/services');
const { adminOnly } = require('./access');

const router = express.Router();

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
  await audit.append(req.user, 'create_tariff', 'tariff', id, { usageType, basis, rate: Number(rate) });
  res.status(201).json({ message: 'Tariff saved as draft. Approve it to make it available to licensees.', id });
});

router.post('/tariffs/:id/:decision', adminOnly, async (req, res) => {
  const { decision } = req.params;
  const newStatus = { approve: 'approved', retire: 'retired' }[decision];
  if (!newStatus) return res.status(404).json({ message: 'Unknown action.' });
  const result = await db.prepare('UPDATE tariffs SET status = ?, approved_by = ? WHERE id = ?').run(newStatus, req.user.id, req.params.id);
  if (!result.changes) return res.status(404).json({ message: 'Tariff not found.' });
  await audit.append(req.user, `${decision}_tariff`, 'tariff', req.params.id, null);
  res.json({ message: `Tariff ${newStatus}.` });
});

module.exports = router;
