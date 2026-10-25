// =============================================================================
// routes/admin/access.js — who may use the government console API
// =============================================================================

const { requireRole } = require('../../lib/security/auth');

/** Admins AND auditors may read every admin endpoint. */
const readAccess = requireRole('admin', 'auditor');

/** Only admins may change anything (auditors are read-only). */
const adminOnly = requireRole('admin');

module.exports = { readAccess, adminOnly };
