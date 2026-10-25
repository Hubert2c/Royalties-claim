// =============================================================================
// lib/crypto-box.js — encrypt sensitive fields before they are stored
// -----------------------------------------------------------------------------
// The document's non-functional requirements ask for "encryption of personal
// and payment data". Payout phone numbers / bank accounts are encrypted with
// AES-256-GCM before they go into the database. Only the last 4 digits are kept
// in plain text so the UI can show "•••• 3456".
//
// The key comes from the DATA_ENCRYPTION_KEY environment variable. Any string
// works: it is hashed into a 32-byte key with SHA-256.
// =============================================================================

const crypto = require('crypto');

const DEV_KEY = 'royalty-hub-development-key-change-me';
if (process.env.NODE_ENV === 'production' && !process.env.DATA_ENCRYPTION_KEY) {
  console.warn('[security] DATA_ENCRYPTION_KEY is not set — using the development key. Set it in production!');
}

function getKey() {
  return crypto.createHash('sha256').update(process.env.DATA_ENCRYPTION_KEY || DEV_KEY).digest();
}

// Returns "iv.authTag.ciphertext" (all base64) so everything needed to decrypt
// is stored together in one text column.
function encrypt(plainText) {
  if (plainText === null || plainText === undefined || plainText === '') return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted].map((part) => part.toString('base64')).join('.');
}

function decrypt(packed) {
  if (!packed) return null;
  const [iv, tag, data] = String(packed).split('.').map((part) => Buffer.from(part, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt };
