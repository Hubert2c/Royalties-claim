// =============================================================================
// lib/security/FieldEncryptor.js — encrypt sensitive fields before storing them
// -----------------------------------------------------------------------------
// The document's non-functional requirements ask for "encryption of personal
// and payment data". Payout phone numbers / bank accounts are encrypted with
// AES-256-GCM (authenticated encryption: tampering is detected on decrypt).
// Only the last 4 digits are kept in plain text, so screens can show "•••• 3456".
//
// The key comes from DATA_ENCRYPTION_KEY (any string; it is hashed to 32 bytes
// with SHA-256). The key lives outside the database, so a stolen database file
// alone does not reveal the numbers.
// =============================================================================

const crypto = require('crypto');

class FieldEncryptor {
  static DEV_SECRET = 'royalty-hub-development-key-change-me';

  /** @param {string} [secret] - defaults to DATA_ENCRYPTION_KEY */
  constructor(secret = process.env.DATA_ENCRYPTION_KEY || FieldEncryptor.DEV_SECRET) {
    this.key = crypto.createHash('sha256').update(secret).digest(); // private: never logged or returned
  }

  /** @returns {string|null} "iv.authTag.ciphertext" in base64, or null for an empty value */
  encrypt(plainText) {
    if (plainText === null || plainText === undefined || plainText === '') return null;
    const iv = crypto.randomBytes(12); // a fresh random IV for every value
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString('base64')).join('.');
  }

  /** Reverse of encrypt(). Throws if the stored value was changed. */
  decrypt(packed) {
    if (!packed) return null;
    const [iv, tag, data] = String(packed).split('.').map((part) => Buffer.from(part, 'base64'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  }
}

if (process.env.NODE_ENV === 'production' && !process.env.DATA_ENCRYPTION_KEY) {
  console.warn('[security] DATA_ENCRYPTION_KEY is not set — using the development key. Set it in production!');
}

/** The shared instance used by the API. */
const fieldEncryptor = new FieldEncryptor();

module.exports = { FieldEncryptor, fieldEncryptor };
