// =============================================================================
// lib/auth.js — logins (JWT), roles and API keys
// -----------------------------------------------------------------------------
// Roles (Section 3.3.2, "role-based access"):
//   admin        — government administrator (Rwanda Intellectual Property Office)
//   auditor      — independent auditor / Parliament: can READ everything, change nothing
//   rightsholder — songwriter, composer, publisher or performer
//   licensee     — radio/TV station, event organiser, advertiser, venue, telecom...
//
// People log in with email + password and receive a JWT (a signed token) that
// the browser sends in the "Authorization: Bearer <token>" header.
// Machines (playout systems, radio monitors) use an API key in "X-API-Key".
// =============================================================================

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { db } = require('../database');

const JWT_SECRET = process.env.JWT_SECRET || 'royalty-hub-dev-secret';
if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
  console.warn('[security] JWT_SECRET is not set — using the development secret. Set it in production!');
}

const ROLES = ['admin', 'auditor', 'rightsholder', 'licensee'];

function createToken(user) {
  return jwt.sign({ id: user.id, email: user.email, name: user.name, role: user.role }, JWT_SECRET, { expiresIn: '8h' });
}

// Middleware: the request must carry a valid login token.
async function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Please log in first.' });
  }
  try {
    const payload = jwt.verify(header.slice(7), JWT_SECRET);
    // Re-read the user so a deleted account or changed role takes effect immediately.
    const user = await db.prepare('SELECT id, name, email, role FROM users WHERE id = ?').get(payload.id);
    if (!user) return res.status(401).json({ message: 'Your account no longer exists.' });
    req.user = user;
    return next();
  } catch (error) {
    return res.status(401).json({ message: 'Your session has expired. Please log in again.' });
  }
}

// Middleware factory: only the listed roles may continue.
// Usage: router.get('/x', authRequired, requireRole('admin', 'auditor'), handler)
function requireRole(...allowed) {
  return (req, res, next) => {
    if (!req.user || !allowed.includes(req.user.role)) {
      return res.status(403).json({ message: 'You do not have permission to do this.' });
    }
    return next();
  };
}

// --- API keys ----------------------------------------------------------------
// A key looks like "rh_live_3f9a..."; only its SHA-256 hash is stored, so a
// leaked database does not leak usable keys.
function hashKey(key) {
  return crypto.createHash('sha256').update(String(key)).digest('hex');
}

function generateApiKey() {
  const key = `rh_live_${crypto.randomBytes(24).toString('hex')}`;
  return { key, prefix: key.slice(0, 12), hash: hashKey(key) };
}

// Middleware: the request must carry a valid, non-revoked API key.
async function apiKeyRequired(req, res, next) {
  const key = req.headers['x-api-key'];
  if (!key) return res.status(401).json({ message: 'Missing X-API-Key header.' });
  const row = await db.prepare('SELECT * FROM api_keys WHERE key_hash = ? AND revoked = 0').get(hashKey(key));
  if (!row) return res.status(401).json({ message: 'Invalid or revoked API key.' });
  req.apiKey = row; // { owner_type, owner_id, ... }
  return next();
}

module.exports = { JWT_SECRET, ROLES, createToken, authRequired, requireRole, generateApiKey, hashKey, apiKeyRequired };
