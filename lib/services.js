// =============================================================================
// lib/services.js — the "composition root": build each service once and share it
// -----------------------------------------------------------------------------
// Routes import ready-made objects from here instead of creating their own.
// Every service receives its collaborators through its constructor
// (dependency injection), so tests can build them with fakes instead.
// =============================================================================

const { db, newId, nowIso } = require('../database');
const { AuditLog } = require('./audit/AuditLog');
const { NotificationService } = require('./notifications/NotificationService');
const { UsageService } = require('./usage/UsageService');
const { DistributionService } = require('./royalties/DistributionService');
const { RoyaltyEngine } = require('./royalties/RoyaltyEngine');
const { LicensingService } = require('./licensing/LicensingService');
const { fieldEncryptor } = require('./security/FieldEncryptor');

const audit = new AuditLog(db);
const notifications = new NotificationService({ db, newId, nowIso });
const usage = new UsageService({ db, newId, nowIso });
const licensing = new LicensingService({ db, newId, nowIso });
const distributions = new DistributionService({ db, newId, nowIso, notifications, engine: new RoyaltyEngine() });

/** The current administration fee rate (a setting the administrator can change, max 30%). */
async function getAdminFeeRate() {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'admin_fee_rate'").get();
  return row ? Number(row.value) : 0.15;
}

module.exports = { audit, notifications, usage, licensing, distributions, fieldEncryptor, getAdminFeeRate };
