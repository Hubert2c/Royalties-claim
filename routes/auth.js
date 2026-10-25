// =============================================================================
// routes/auth.js — register, log in, "who am I"
// -----------------------------------------------------------------------------
// Anyone can register as a RIGHTS HOLDER (artist) or a LICENSEE (music user).
// Administrator and auditor accounts are created by the government, never by
// self-registration.
// =============================================================================

const express = require('express');
const bcrypt = require('bcryptjs');
const { db, newId, nowIso } = require('../database');
const { createToken, authRequired } = require('../lib/auth');
const { appendAudit } = require('../lib/audit');
const { encrypt } = require('../lib/crypto-box');
const { CATEGORIES } = require('../lib/tariffs');

const router = express.Router();

const isEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
const HOLDER_TYPES = ['writer', 'composer', 'publisher', 'performer'];

// POST /api/auth/register
// Body (rights holder): { name, email, password, role: "rightsholder", holderType, ipiNumber, payoutMethod, payoutRef }
// Body (licensee):      { name, email, password, role: "licensee", organisation, category, tin, ruraLicenceNo }
router.post('/register', async (req, res) => {
  const { name, email, password, role } = req.body || {};

  if (!name || !email || !password) return res.status(400).json({ message: 'Name, email and password are required.' });
  if (!isEmail(email)) return res.status(400).json({ message: 'Please provide a valid email address.' });
  if (String(password).length < 8) return res.status(400).json({ message: 'Password must be at least 8 characters long.' });
  if (!['rightsholder', 'licensee'].includes(role)) {
    return res.status(400).json({ message: 'You can register as a rights holder or as a licensee.' });
  }

  const normalizedEmail = String(email).trim().toLowerCase();
  if (await db.prepare('SELECT 1 AS found FROM users WHERE email = ?').get(normalizedEmail)) {
    return res.status(409).json({ message: 'A user with this email already exists.' });
  }

  // Validate the role-specific fields BEFORE creating anything.
  if (role === 'rightsholder') {
    if (!HOLDER_TYPES.includes(req.body.holderType)) return res.status(400).json({ message: 'Please choose writer, composer, publisher or performer.' });
    if (req.body.payoutMethod && !['momo', 'bank'].includes(req.body.payoutMethod)) return res.status(400).json({ message: 'Payout method must be mobile money or bank.' });
  } else {
    if (!req.body.organisation) return res.status(400).json({ message: 'Organisation name is required.' });
    if (!CATEGORIES.includes(req.body.category)) return res.status(400).json({ message: 'Please choose a valid licensee category.' });
  }

  const userId = newId('USR');
  await db.prepare('INSERT INTO users (id, name, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(userId, String(name).trim(), normalizedEmail, bcrypt.hashSync(String(password), 10), role, nowIso());

  let profileId;
  if (role === 'rightsholder') {
    profileId = newId('RH');
    const payoutRef = req.body.payoutRef ? String(req.body.payoutRef).trim() : '';
    await db.prepare(`INSERT INTO rights_holders (id, user_id, full_name, ipi_number, holder_type, payout_method,
        payout_ref_encrypted, payout_ref_last4, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(profileId, userId, String(name).trim(), req.body.ipiNumber ? String(req.body.ipiNumber).trim() : null,
        req.body.holderType, req.body.payoutMethod || null, encrypt(payoutRef), payoutRef ? payoutRef.slice(-4) : null, 'active', nowIso());
  } else {
    profileId = newId('LIC');
    await db.prepare('INSERT INTO licensees (id, user_id, name, category, tin, rura_licence_no, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(profileId, userId, String(req.body.organisation).trim(), req.body.category,
        req.body.tin ? String(req.body.tin).trim() : null, req.body.ruraLicenceNo ? String(req.body.ruraLicenceNo).trim() : null, nowIso());
  }

  const user = { id: userId, name: String(name).trim(), email: normalizedEmail, role };
  await appendAudit(db, user, 'register', role === 'rightsholder' ? 'rights_holder' : 'licensee', profileId, { email: normalizedEmail });
  return res.status(201).json({ token: createToken(user), user });
});

// POST /api/auth/login   Body: { email, password, portal? }
// "portal" (optional) stops, for example, an artist from logging into the government console.
router.post('/login', async (req, res) => {
  const { email, password, portal } = req.body || {};
  if (!email || !password) return res.status(400).json({ message: 'Email and password are required.' });

  const user = await db.prepare('SELECT * FROM users WHERE email = ?').get(String(email).trim().toLowerCase());
  if (!user || !bcrypt.compareSync(String(password), user.password_hash)) {
    return res.status(401).json({ message: 'Invalid email or password.' });
  }

  const portalRoles = { government: ['admin', 'auditor'], rightsholder: ['rightsholder'], licensee: ['licensee'] };
  if (portal && portalRoles[portal] && !portalRoles[portal].includes(user.role)) {
    return res.status(403).json({ message: 'This account cannot use this portal. Please use the portal for your role.' });
  }

  const safeUser = { id: user.id, name: user.name, email: user.email, role: user.role };
  await appendAudit(db, safeUser, 'login', 'user', user.id, null);
  return res.json({ token: createToken(safeUser), user: safeUser });
});

// GET /api/me — the logged-in user (and their profile, if any)
router.get('/me', authRequired, async (req, res) => {
  let profile = null;
  if (req.user.role === 'rightsholder') {
    profile = await db.prepare('SELECT id, full_name, ipi_number, holder_type, payout_method, payout_ref_last4, status FROM rights_holders WHERE user_id = ?').get(req.user.id);
  } else if (req.user.role === 'licensee') {
    profile = await db.prepare('SELECT * FROM licensees WHERE user_id = ?').get(req.user.id);
  }
  return res.json({ user: req.user, profile });
});

module.exports = router;
