// =============================================================================
// lib/security/auth.js — logins (JWT), roles and API keys
// -----------------------------------------------------------------------------
// Roles (Section 3.3.2, "role-based access"):
//   admin        — government administrator (Rwanda Intellectual Property Office)
//   auditor      — independent auditor / Parliament: reads everything, changes nothing
//   rightsholder — songwriter, composer, publisher or performer
//   licensee     — radio/TV station, event organiser, advertiser, venue, telecom...
//
// People log in with email + password and get a JWT (a signed token) that the
// browser sends as "Authorization: Bearer <token>".
// Machines (playout systems, radio monitors) send an API key in "X-API-Key".
//
// TokenService and ApiKeyService hold the logic; the functions at the bottom
// are thin Express middleware that use them.
// =============================================================================

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { db } = require('../../database');

const ROLES = ['admin', 'auditor', 'rightsholder', 'licensee'];

class TokenService {
  /** @param {string} secret - JWT signing secret */
  constructor(secret) {
    this.secret = secret;
  }

  /** Sign a token that is valid for 8 hours. */
  create(user) {
    return jwt.sign({ id: user.id, email: user.email, name: user.name, role: user.role }, this.secret, { expiresIn: '8h' });
  }

  /** @returns {object} the token payload; throws if invalid or expired */
  verify(token) {
    return jwt.verify(token, this.secret);
  }
}

class ApiKeyService {
  static PREFIX = 'rh_live_';

  /** Only the SHA-256 hash of a key is stored, so a leaked database leaks no usable keys. */
  static hash(key) {
    return crypto.createHash('sha256').update(String(key)).digest('hex');
  }

  /** A new random key; the full key is shown once to its owner, then only the hash is kept. */
  static generate() {
    const key = `${ApiKeyService.PREFIX}${crypto.randomBytes(24).toString('hex')}`;
    return { key, prefix: key.slice(0, 12), hash: ApiKeyService.hash(key) };
  }

  constructor(database) {
    this.db = database;
  }

  /** @returns {Promise<object|null>} the stored key row if valid and not revoked */
  async findActive(key) {
    return this.db.prepare('SELECT * FROM api_keys WHERE key_hash = ? AND revoked = 0').get(ApiKeyService.hash(key));
  }
}

const JWT_SECRET = process.env.JWT_SECRET || 'royalty-hub-dev-secret';
if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
  console.warn('[security] JWT_SECRET is not set — using the development secret. Set it in production!');
}
const tokens = new TokenService(JWT_SECRET);
const apiKeys = new ApiKeyService(db);

// --- Express middleware -----------------------------------------------------------

/** The request must carry a valid login token. */
async function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return res.status(401).json({ message: 'Please log in first.' });
  try {
    const payload = tokens.verify(header.slice(7));
    // Re-read the user so a deleted account or a changed role takes effect at once.
    const user = await db.prepare('SELECT id, name, email, role FROM users WHERE id = ?').get(payload.id);
    if (!user) return res.status(401).json({ message: 'Your account no longer exists.' });
    req.user = user;
    return next();
  } catch (error) {
    return res.status(401).json({ message: 'Your session has expired. Please log in again.' });
  }
}

/** Only the listed roles may continue: router.get('/x', authRequired, requireRole('admin'), handler) */
function requireRole(...allowed) {
  return (req, res, next) => {
    if (!req.user || !allowed.includes(req.user.role)) {
      return res.status(403).json({ message: 'You do not have permission to do this.' });
    }
    return next();
  };
}

/** The request must carry a valid, non-revoked API key. */
async function apiKeyRequired(req, res, next) {
  const key = req.headers['x-api-key'];
  if (!key) return res.status(401).json({ message: 'Missing X-API-Key header.' });
  const row = await apiKeys.findActive(key);
  if (!row) return res.status(401).json({ message: 'Invalid or revoked API key.' });
  req.apiKey = row; // { owner_type, owner_id, ... }
  return next();
}

module.exports = {
  ROLES,
  TokenService,
  ApiKeyService,
  tokens,
  createToken: (user) => tokens.create(user),
  generateApiKey: () => ApiKeyService.generate(),
  authRequired,
  requireRole,
  apiKeyRequired
};
