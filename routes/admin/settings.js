// =============================================================================
// routes/admin/settings.js — Audit log (FR-11), settings and API keys for monitors (FR-13).
// Mounted under /api/admin by routes/admin/index.js (admins and auditors may
// read; only admins may change things).
// =============================================================================

const express = require('express');
const { db, newId, nowIso } = require('../../database');
const { generateApiKey } = require('../../lib/security/auth');
const { RoyaltyEngine } = require('../../lib/royalties/RoyaltyEngine');
const { audit, getAdminFeeRate } = require('../../lib/services');
const { adminOnly } = require('./access');

const router = express.Router();

// --- Audit log (FR-11) -----------------------------------------------------------

router.get('/audit', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  const entries = await db.prepare(`SELECT a.*, u.name AS actor_name FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
    ORDER BY a.seq DESC LIMIT ${limit}`).all();
  res.json({ entries });
});

router.get('/audit/verify', async (req, res) => {
  res.json({ verification: await audit.verify() });
});

// --- Settings ----------------------------------------------------------------------

router.get('/settings', async (req, res) => {
  res.json({ adminFeeRate: await getAdminFeeRate(), maxAdminFeeRate: RoyaltyEngine.MAX_ADMIN_FEE_RATE });
});

router.put('/settings', adminOnly, async (req, res) => {
  const rate = Number(req.body.adminFeeRate);
  if (!Number.isFinite(rate) || rate < 0 || rate > RoyaltyEngine.MAX_ADMIN_FEE_RATE) {
    return res.status(400).json({ message: `The administration fee must be between 0% and ${RoyaltyEngine.MAX_ADMIN_FEE_RATE * 100}%.` });
  }
  const existing = await db.prepare("SELECT 1 AS found FROM settings WHERE key = 'admin_fee_rate'").get();
  if (existing) await db.prepare("UPDATE settings SET value = ? WHERE key = 'admin_fee_rate'").run(String(rate));
  else await db.prepare("INSERT INTO settings (key, value) VALUES ('admin_fee_rate', ?)").run(String(rate));
  await audit.append(req.user, 'update_admin_fee_rate', 'settings', 'admin_fee_rate', { rate });
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
  await audit.append(req.user, 'create_api_key', 'api_key', id, { label, type: 'monitor' });
  res.status(201).json({ message: 'Monitor API key created. Copy it now — it will not be shown again.', key, id });
});

router.post('/api-keys/:id/revoke', adminOnly, async (req, res) => {
  const result = await db.prepare('UPDATE api_keys SET revoked = 1 WHERE id = ?').run(req.params.id);
  if (!result.changes) return res.status(404).json({ message: 'Key not found.' });
  await audit.append(req.user, 'revoke_api_key', 'api_key', req.params.id, null);
  res.json({ message: 'API key revoked.' });
});

module.exports = router;

module.exports = router;
