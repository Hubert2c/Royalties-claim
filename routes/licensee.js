// =============================================================================
// routes/licensee.js — API for the Licensee portal (music users)
// -----------------------------------------------------------------------------
// Covers functional requirements:
//   FR-3  apply for licences and receive invoices calculated from approved tariffs
//   FR-4  submit usage: play logs, set lists, ad cue sheets, CSV/DDEX reports
//   FR-13 create API keys so the licensee's own systems can report automatically
// Payments are SIMULATED in this prototype (no real money moves): the
// "mobile money" step just records a payment with a generated reference.
// =============================================================================

const express = require('express');
const multer = require('multer');
const { db, newId, nowIso } = require('../database');
const { audit, licensing, notifications, usage: usageService } = require('../lib/services');
const { authRequired, requireRole, generateApiKey } = require('../lib/security/auth');
const { UsageService } = require('../lib/usage/UsageService');
const { CsvUsageParser, JsonUsageParser } = require('../lib/usage/ReportParsers');
const { rwf } = require('../lib/util/format');

const router = express.Router();
router.use(authRequired, requireRole('licensee'));

// CSV usage reports are read in memory (max 2 MB) — they are not kept as files.
const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

async function myLicensee(req) {
  return db.prepare('SELECT * FROM licensees WHERE user_id = ?').get(req.user.id);
}

// --- Profile ---------------------------------------------------------------------

router.get('/profile', async (req, res) => res.json({ profile: await myLicensee(req) }));

router.put('/profile', async (req, res) => {
  const licensee = await myLicensee(req);
  const { tin, ruraLicenceNo } = req.body || {};
  await db.prepare('UPDATE licensees SET tin = ?, rura_licence_no = ? WHERE id = ?')
    .run(tin ? String(tin).trim() : licensee.tin, ruraLicenceNo ? String(ruraLicenceNo).trim() : licensee.rura_licence_no, licensee.id);
  await audit.append(req.user, 'update_profile', 'licensee', licensee.id, null);
  return res.json({ message: 'Profile updated.' });
});

// --- Tariffs & licences (FR-3) ---------------------------------------------------

router.get('/tariffs', async (req, res) => {
  const tariffs = await db.prepare("SELECT * FROM tariffs WHERE status = 'approved' ORDER BY usage_type, name").all();
  return res.json({ tariffs });
});

router.get('/licences', async (req, res) => {
  const licensee = await myLicensee(req);
  const licences = await db.prepare(`
    SELECT l.*, t.name AS tariff_name, t.basis, t.rate,
      (SELECT reference FROM payments p WHERE p.licence_id = l.id ORDER BY paid_at DESC LIMIT 1) AS payment_reference
    FROM licences l JOIN tariffs t ON t.id = l.tariff_id
    WHERE l.licensee_id = ? ORDER BY l.created_at DESC
  `).all(licensee.id);
  return res.json({ licences });
});

// POST /api/licensee/licences  Body: { tariffId, periodStart, periodEnd, quantity, grossAmount, description }
router.post('/licences', async (req, res) => {
  const licensee = await myLicensee(req);
  try {
    const { licenceId, tariff, fee, explanation } = await licensing.apply(licensee.id, req.body || {});
    await audit.append(req.user, 'apply_licence', 'licence', licenceId, { tariff: tariff.id, fee });
    await notifications.notifyRoles(['admin'], `New licence application from ${licensee.name}`, `${tariff.name}: ${rwf(fee)}.`, 'licences');
    return res.status(201).json({ message: `Application sent. Estimated fee: Rwf ${fee.toLocaleString('en-US')} (${explanation}).`, licenceId, fee });
  } catch (error) {
    return res.status(error.status || 400).json({ message: error.message });
  }
});

// POST /api/licensee/licences/:id/pay  Body: { channel: "momo"|"bank"|"irembo", payer }
// The money goes to the government royalty account through the payment gateway.
router.post('/licences/:id/pay', async (req, res) => {
  const licensee = await myLicensee(req);
  const { licence, paymentId, channel, reference, simulated } = await licensing.pay(req.params.id, licensee.id, req.body || {});
  await audit.append(req.user, 'pay_licence', 'payment', paymentId, { licence: licence.id, amount: licence.fee_due, channel, reference, simulated });
  await notifications.notifyRoles(['admin'], `${licensee.name} paid ${rwf(licence.fee_due)}`, `Clearance code ${licence.clearance_code} is now valid.`, 'licences');
  return res.json({ message: `Payment recorded${simulated ? ' (simulated)' : ''}. Reference ${reference}.`, reference });
});

// --- Usage reporting (FR-4) ------------------------------------------------------

// POST /api/licensee/usage  Body: { source, rows: [{ played_at, title, artist, isrc, duration_sec }] }
router.post('/usage', async (req, res) => {
  const licensee = await myLicensee(req);
  const { source, rows } = req.body || {};
  try {
    UsageService.assertReportable(source);
    const summary = await usageService.record({ licenseeId: licensee.id, source, rows: new JsonUsageParser().parse(rows) });
    await audit.append(req.user, 'report_usage', 'usage_events', null, { source, saved: summary.saved, matched: summary.matched });
    return res.status(201).json({ message: `${summary.saved} usage rows saved (${summary.matched} matched, ${summary.unmatched} unmatched).`, summary });
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }
});

// POST /api/licensee/usage/csv  (multipart: file, source)
// CSV header: played_at,title,artist,isrc,duration_sec
router.post('/usage/csv', (req, res, next) => {
  csvUpload.single('file')(req, res, async (uploadError) => {
    try {
      if (uploadError) return res.status(400).json({ message: uploadError.message });
      if (!req.file) return res.status(400).json({ message: 'Please choose a CSV file.' });
      const licensee = await myLicensee(req);
      const source = req.body.source || 'play_log';
      if (!UsageService.REPORTABLE_SOURCES.includes(source)) return res.status(400).json({ message: 'Unknown report type.' });

      // Throws a ValidationError (HTTP 400) when the file has no data rows.
      const rows = new CsvUsageParser().parse(req.file.buffer.toString('utf8'));

      const summary = await usageService.record({ licenseeId: licensee.id, source, rows });
      await audit.append(req.user, 'report_usage_csv', 'usage_events', null, { source, file: req.file.originalname, saved: summary.saved, matched: summary.matched });
      return res.status(201).json({ message: `${summary.saved} rows imported (${summary.matched} matched, ${summary.unmatched} unmatched).`, summary });
    } catch (error) {
      if (error.message && !error.status) return res.status(400).json({ message: error.message });
      return next(error);
    }
  });
});

// GET /api/licensee/usage — my latest 200 usage events
router.get('/usage', async (req, res) => {
  const licensee = await myLicensee(req);
  const usage = await db.prepare(`
    SELECT u.*, rec.title AS recording_title FROM usage_events u LEFT JOIN recordings rec ON rec.id = u.recording_id
    WHERE u.licensee_id = ? ORDER BY u.played_at DESC LIMIT 200
  `).all(licensee.id);
  return res.json({ usage });
});

// --- API keys (FR-13) ------------------------------------------------------------

router.get('/api-keys', async (req, res) => {
  const licensee = await myLicensee(req);
  const keys = await db.prepare("SELECT id, label, key_prefix, revoked, created_at FROM api_keys WHERE owner_type = 'licensee' AND owner_id = ? ORDER BY created_at DESC").all(licensee.id);
  return res.json({ keys });
});

router.post('/api-keys', async (req, res) => {
  const licensee = await myLicensee(req);
  const label = String(req.body.label || 'Playout system').slice(0, 80);
  const { key, prefix, hash } = generateApiKey();
  const id = newId('KEY');
  await db.prepare('INSERT INTO api_keys (id, owner_type, owner_id, label, key_prefix, key_hash, revoked, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, 'licensee', licensee.id, label, prefix, hash, 0, nowIso());
  await audit.append(req.user, 'create_api_key', 'api_key', id, { label });
  // The full key is shown ONCE — only its hash is stored.
  return res.status(201).json({ message: 'API key created. Copy it now — it will not be shown again.', key, id });
});

router.post('/api-keys/:id/revoke', async (req, res) => {
  const licensee = await myLicensee(req);
  const result = await db.prepare("UPDATE api_keys SET revoked = 1 WHERE id = ? AND owner_type = 'licensee' AND owner_id = ?").run(req.params.id, licensee.id);
  if (!result.changes) return res.status(404).json({ message: 'Key not found.' });
  await audit.append(req.user, 'revoke_api_key', 'api_key', req.params.id, null);
  return res.json({ message: 'API key revoked.' });
});

module.exports = router;
