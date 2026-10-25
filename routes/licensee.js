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
const crypto = require('crypto');
const { db, newId, nowIso } = require('../database');
const { authRequired, requireRole, generateApiKey } = require('../lib/auth');
const { appendAudit } = require('../lib/audit');
const { computeFee } = require('../lib/tariffs');
const { recordUsage, SOURCES } = require('../lib/usage');
const { parseCsv } = require('../lib/csv');
const { notifyRoles, rwf } = require('../lib/notify');

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
  await appendAudit(db, req.user, 'update_profile', 'licensee', licensee.id, null);
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
  const { tariffId, periodStart, periodEnd, quantity, grossAmount, description } = req.body || {};

  const tariff = await db.prepare("SELECT * FROM tariffs WHERE id = ? AND status = 'approved'").get(tariffId);
  if (!tariff) return res.status(400).json({ message: 'Please choose an approved tariff.' });
  if (!periodStart || !periodEnd || new Date(periodEnd) < new Date(periodStart)) {
    return res.status(400).json({ message: 'Please give a valid licence period (the end date must be after the start date).' });
  }

  let fee;
  try {
    fee = computeFee(tariff, { periodStart, periodEnd, quantity: Number(quantity), grossAmount: Number(grossAmount) });
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }

  const licenceId = newId('LCN');
  await db.prepare(`INSERT INTO licences (id, licensee_id, tariff_id, period_start, period_end, quantity, gross_amount, fee_due,
      status, clearance_code, description, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(licenceId, licensee.id, tariff.id, periodStart, periodEnd,
      Number.isInteger(Number(quantity)) && Number(quantity) > 0 ? Number(quantity) : null,
      Number(grossAmount) > 0 ? Math.round(Number(grossAmount)) : null,
      fee.fee, 'applied', null, description ? String(description).slice(0, 300) : null, nowIso());

  await appendAudit(db, req.user, 'apply_licence', 'licence', licenceId, { tariff: tariff.id, fee: fee.fee });
  await notifyRoles(['admin'], `New licence application from ${licensee.name}`, `${tariff.name}: ${rwf(fee.fee)}.`, 'licences');
  return res.status(201).json({ message: `Application sent. Estimated fee: Rwf ${fee.fee.toLocaleString('en-US')} (${fee.explanation}).`, licenceId, fee: fee.fee });
});

// POST /api/licensee/licences/:id/pay  Body: { channel: "momo"|"bank"|"irembo", payer }
// SIMULATED payment: records the payment and marks the licence as paid.
router.post('/licences/:id/pay', async (req, res) => {
  const licensee = await myLicensee(req);
  const licence = await db.prepare('SELECT * FROM licences WHERE id = ? AND licensee_id = ?').get(req.params.id, licensee.id);
  if (!licence) return res.status(404).json({ message: 'Licence not found.' });
  if (licence.status !== 'invoiced') return res.status(409).json({ message: licence.status === 'paid' ? 'This licence is already paid.' : 'This licence has not been approved and invoiced yet.' });

  const channel = ['momo', 'bank', 'irembo'].includes(req.body.channel) ? req.body.channel : 'momo';
  if (channel === 'momo' && !/^07\d{8}$/.test(String(req.body.payer || '').replace(/\s+/g, ''))) {
    return res.status(400).json({ message: 'Enter the mobile money number that will pay (e.g. 0788123456).' });
  }

  const reference = `${channel.toUpperCase()}-SIM-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  const paymentId = newId('PAY');
  await db.prepare('INSERT INTO payments (id, licence_id, amount, channel, reference, paid_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(paymentId, licence.id, licence.fee_due, channel, reference, nowIso());
  await db.prepare("UPDATE licences SET status = 'paid' WHERE id = ?").run(licence.id);

  await appendAudit(db, req.user, 'pay_licence', 'payment', paymentId, { licence: licence.id, amount: licence.fee_due, channel, reference, simulated: true });
  await notifyRoles(['admin'], `${licensee.name} paid ${rwf(licence.fee_due)}`, `Clearance code ${licence.clearance_code} is now valid.`, 'licences');
  return res.json({ message: `Payment recorded (simulated). Reference ${reference}.`, reference });
});

// --- Usage reporting (FR-4) ------------------------------------------------------

// POST /api/licensee/usage  Body: { source, rows: [{ played_at, title, artist, isrc, duration_sec }] }
router.post('/usage', async (req, res) => {
  const licensee = await myLicensee(req);
  const { source, rows } = req.body || {};
  if (!SOURCES.includes(source) || source === 'simulation' || source === 'fingerprint') {
    return res.status(400).json({ message: 'Source must be play_log, set_list, cue_sheet or ddex.' });
  }
  try {
    const summary = await recordUsage({ licenseeId: licensee.id, source, rows });
    await appendAudit(db, req.user, 'report_usage', 'usage_events', null, { source, saved: summary.saved, matched: summary.matched });
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
      if (!['play_log', 'set_list', 'cue_sheet', 'ddex'].includes(source)) return res.status(400).json({ message: 'Unknown report type.' });

      const rows = parseCsv(req.file.buffer.toString('utf8'));
      if (!rows.length) return res.status(400).json({ message: 'The CSV file has no data rows. The first line must be: played_at,title,artist,isrc,duration_sec' });

      const summary = await recordUsage({ licenseeId: licensee.id, source, rows });
      await appendAudit(db, req.user, 'report_usage_csv', 'usage_events', null, { source, file: req.file.originalname, saved: summary.saved, matched: summary.matched });
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
  await appendAudit(db, req.user, 'create_api_key', 'api_key', id, { label });
  // The full key is shown ONCE — only its hash is stored.
  return res.status(201).json({ message: 'API key created. Copy it now — it will not be shown again.', key, id });
});

router.post('/api-keys/:id/revoke', async (req, res) => {
  const licensee = await myLicensee(req);
  const result = await db.prepare("UPDATE api_keys SET revoked = 1 WHERE id = ? AND owner_type = 'licensee' AND owner_id = ?").run(req.params.id, licensee.id);
  if (!result.changes) return res.status(404).json({ message: 'Key not found.' });
  await appendAudit(db, req.user, 'revoke_api_key', 'api_key', req.params.id, null);
  return res.json({ message: 'API key revoked.' });
});

module.exports = router;
