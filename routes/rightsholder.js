// =============================================================================
// routes/rightsholder.js — API for the Rights-holder (artist) portal
// -----------------------------------------------------------------------------
// Covers functional requirements:
//   FR-1  register works, recordings and identifiers (ISWC, ISRC, IPI)
//   FR-2  declare and confirm splits (must total 100%)
//   FR-8  itemised royalty statements
//   FR-9  claim unmatched ("black box") usage
// All routes require a logged-in user with role "rightsholder".
// =============================================================================

const express = require('express');
const path = require('path');
const multer = require('multer');
const { db, newId, nowIso } = require('../database');
const { audit, fieldEncryptor, notifications } = require('../lib/services');
const { authRequired, requireRole } = require('../lib/security/auth');
const { FingerprintMatcher } = require('../lib/fingerprint/FingerprintMatcher');
const { RoyaltyEngine } = require('../lib/royalties/RoyaltyEngine');

const router = express.Router();
router.use(authRequired, requireRole('rightsholder'));

const RIGHT_TYPES = ['lyrics', 'music', 'publishing', 'performance'];

// Optional evidence files for claims (PDF, Word, images; max 5 MB by default).
const uploadDir = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads'));
const evidenceUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname.replace(/[^\w.-]+/g, '-')}`)
  }),
  limits: { fileSize: Number(process.env.MAX_FILE_SIZE) || 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['application/pdf', 'application/msword', 'image/png', 'image/jpeg',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
    return allowed.includes(file.mimetype) ? cb(null, true) : cb(new Error('Allowed evidence files: PDF, DOC, DOCX, PNG, JPG.'));
  }
});

// Helper: the rights-holder profile of the logged-in user.
async function myHolder(req) {
  return db.prepare('SELECT * FROM rights_holders WHERE user_id = ?').get(req.user.id);
}

// Helper: after any split change, set the work to "active" only when its splits are complete.
async function refreshWorkStatus(workId) {
  const splits = await db.prepare("SELECT * FROM splits WHERE work_id = ? AND status <> 'rejected'").all(workId);
  const status = RoyaltyEngine.splitsAreComplete(splits) ? 'active' : 'pending_splits';
  await db.prepare('UPDATE works SET status = ? WHERE id = ?').run(status, workId);
  return status;
}

// Helper: check a list of proposed splits. Returns an error message or null.
function validateSplits(splits) {
  if (!Array.isArray(splits) || splits.length === 0) return 'Add at least one split.';
  const ids = new Set();
  let total = 0;
  for (const split of splits) {
    const share = Number(split.share_percent);
    if (!split.holder_id) return 'Every split needs a rights holder.';
    if (ids.has(split.holder_id)) return 'Each rights holder can only appear once per work.';
    if (!Number.isFinite(share) || share <= 0 || share > 100) return 'Each share must be more than 0% and at most 100%.';
    if (!RIGHT_TYPES.includes(split.right_type)) return 'Right type must be lyrics, music, publishing or performance.';
    ids.add(split.holder_id);
    total += share;
  }
  if (Math.abs(total - 100) > 0.001) return `Splits must add up to exactly 100% (they add up to ${Number(total.toFixed(3))}%).`;
  return null;
}

// --- Profile -------------------------------------------------------------------

router.get('/profile', async (req, res) => {
  const holder = await myHolder(req);
  if (!holder) return res.status(404).json({ message: 'Rights-holder profile not found.' });
  delete holder.payout_ref_encrypted; // never send the encrypted value to the browser
  return res.json({ profile: holder });
});

router.put('/profile', async (req, res) => {
  const holder = await myHolder(req);
  const { ipiNumber, payoutMethod, payoutRef } = req.body || {};
  if (payoutMethod && !['momo', 'bank'].includes(payoutMethod)) return res.status(400).json({ message: 'Payout method must be mobile money or bank.' });

  await db.prepare('UPDATE rights_holders SET ipi_number = ?, payout_method = ? WHERE id = ?')
    .run(ipiNumber ? String(ipiNumber).trim() : holder.ipi_number, payoutMethod || holder.payout_method, holder.id);
  if (payoutRef) {
    const ref = String(payoutRef).trim();
    await db.prepare('UPDATE rights_holders SET payout_ref_encrypted = ?, payout_ref_last4 = ? WHERE id = ?').run(fieldEncryptor.encrypt(ref), ref.slice(-4), holder.id);
  }
  await audit.append(req.user, 'update_profile', 'rights_holder', holder.id, { ipi: Boolean(ipiNumber), payout: Boolean(payoutRef) });
  return res.json({ message: 'Profile updated.' });
});

// List registered rights holders, so a writer can add co-writers to a split.
router.get('/holders', async (req, res) => {
  const holders = await db.prepare("SELECT id, full_name, ipi_number, holder_type FROM rights_holders WHERE status = 'active' ORDER BY full_name").all();
  return res.json({ holders });
});

// --- Works, recordings and splits ----------------------------------------------

// GET /api/rightsholder/works — works I created or have a share in
router.get('/works', async (req, res) => {
  const holder = await myHolder(req);
  const works = await db.prepare(`
    SELECT DISTINCT w.* FROM works w
    LEFT JOIN splits s ON s.work_id = w.id
    WHERE w.created_by = ? OR s.holder_id = ?
    ORDER BY w.created_at DESC
  `).all(req.user.id, holder.id);

  for (const work of works) {
    work.recordings = await db.prepare('SELECT id, title, performer, isrc, duration_sec, (fingerprint IS NOT NULL) AS has_fingerprint FROM recordings WHERE work_id = ?').all(work.id);
    work.splits = await db.prepare(`
      SELECT s.id, s.holder_id, s.share_percent, s.right_type, s.status, s.confirmed_at, h.full_name, h.ipi_number
      FROM splits s JOIN rights_holders h ON h.id = s.holder_id
      WHERE s.work_id = ? ORDER BY s.share_percent DESC
    `).all(work.id);
    const mine = work.splits.find((split) => split.holder_id === holder.id);
    work.my_share = mine ? Number(mine.share_percent) : 0;
    work.is_creator = work.created_by === req.user.id;
  }
  return res.json({ works, holderId: holder.id });
});

// POST /api/rightsholder/works
// Body: { title, iswc, recording: { title, performer, isrc, duration_sec, fingerprint }, splits: [{ holder_id, share_percent, right_type }] }
router.post('/works', async (req, res) => {
  const holder = await myHolder(req);
  const { title, iswc, recording = {}, splits } = req.body || {};

  if (!title || !String(title).trim()) return res.status(400).json({ message: 'Work title is required.' });
  if (iswc && !/^T-?\d{3}\.?\d{3}\.?\d{3}-?\d$/i.test(String(iswc).trim())) return res.status(400).json({ message: 'ISWC should look like T-123.456.789-0.' });
  if (recording.isrc && !/^[A-Z]{2}[A-Z0-9]{3}\d{7}$/i.test(String(recording.isrc).replace(/-/g, '').trim())) {
    return res.status(400).json({ message: 'ISRC should look like RWA012600001 (12 characters).' });
  }
  const splitError = validateSplits(splits);
  if (splitError) return res.status(400).json({ message: splitError });

  // Every holder in the split must exist.
  for (const split of splits) {
    if (!await db.prepare('SELECT 1 AS found FROM rights_holders WHERE id = ?').get(split.holder_id)) {
      return res.status(400).json({ message: `Unknown rights holder ${split.holder_id}.` });
    }
  }

  const workId = newId('WRK');
  await db.prepare('INSERT INTO works (id, title, iswc, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(workId, String(title).trim(), iswc ? String(iswc).trim().toUpperCase() : null, 'pending_splits', req.user.id, nowIso());

  const fingerprint = FingerprintMatcher.parse(recording.fingerprint);
  await db.prepare('INSERT INTO recordings (id, work_id, title, performer, isrc, duration_sec, fingerprint, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(newId('REC'), workId, String(recording.title || title).trim(), recording.performer ? String(recording.performer).trim() : holder.full_name,
      recording.isrc ? String(recording.isrc).replace(/-/g, '').trim().toUpperCase() : null,
      Number(recording.duration_sec) || null, fingerprint.length ? fingerprint.join(',') : null, nowIso());

  for (const split of splits) {
    // The person registering the work confirms their own share automatically;
    // every co-writer must confirm theirs in their own portal.
    const isMe = split.holder_id === holder.id;
    await db.prepare('INSERT INTO splits (id, work_id, holder_id, share_percent, right_type, status, confirmed_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(newId('SPL'), workId, split.holder_id, Number(split.share_percent), split.right_type,
        isMe ? 'confirmed' : 'pending', isMe ? nowIso() : null, nowIso());
  }

  const status = await refreshWorkStatus(workId);
  await audit.append(req.user, 'register_work', 'work', workId, { title, splits: splits.map((s) => [s.holder_id, s.share_percent]) });

  // Tell every co-writer that they have a share to confirm.
  for (const split of splits.filter((s) => s.holder_id !== holder.id)) {
    await notifications.notifyHolders(split.holder_id, `Confirm your share of "${String(title).trim()}"`,
      `${holder.full_name} listed you at ${Number(split.share_percent)}% (${split.right_type}). Royalties for this song are held until everyone confirms.`, 'confirm');
  }
  return res.status(201).json({ message: status === 'active' ? 'Work registered.' : 'Work registered. Co-writers must confirm their splits before royalties can be paid.', workId, status });
});

// PUT /api/rightsholder/works/:id/splits — the creator replaces the splits (e.g. after one was rejected)
router.put('/works/:id/splits', async (req, res) => {
  const holder = await myHolder(req);
  const work = await db.prepare('SELECT * FROM works WHERE id = ?').get(req.params.id);
  if (!work) return res.status(404).json({ message: 'Work not found.' });
  if (work.created_by !== req.user.id) return res.status(403).json({ message: 'Only the person who registered the work can change its splits.' });
  if (work.status === 'active') return res.status(409).json({ message: 'Splits are confirmed by everyone. To change them, raise a dispute.' });

  const splitError = validateSplits(req.body.splits);
  if (splitError) return res.status(400).json({ message: splitError });

  // Old pending/rejected splits are marked rejected (kept for the record) and replaced.
  await db.prepare("UPDATE splits SET status = 'rejected' WHERE work_id = ?").run(work.id);
  for (const split of req.body.splits) {
    const isMe = split.holder_id === holder.id;
    await db.prepare('INSERT INTO splits (id, work_id, holder_id, share_percent, right_type, status, confirmed_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(newId('SPL'), work.id, split.holder_id, Number(split.share_percent), split.right_type,
        isMe ? 'confirmed' : 'pending', isMe ? nowIso() : null, nowIso());
  }
  const status = await refreshWorkStatus(work.id);
  await audit.append(req.user, 'replace_splits', 'work', work.id, { splits: req.body.splits.map((s) => [s.holder_id, s.share_percent]) });
  await notifications.notifyHolders(req.body.splits.filter((s) => s.holder_id !== holder.id).map((s) => s.holder_id),
    `Splits changed on "${work.title}"`, 'Please check and confirm your new share.', 'confirm');
  return res.json({ message: 'Splits updated and sent for confirmation.', status });
});

// GET /api/rightsholder/splits/pending — splits waiting for MY confirmation
router.get('/splits/pending', async (req, res) => {
  const holder = await myHolder(req);
  const splits = await db.prepare(`
    SELECT s.*, w.title AS work_title, w.iswc, u.name AS registered_by
    FROM splits s JOIN works w ON w.id = s.work_id LEFT JOIN users u ON u.id = w.created_by
    WHERE s.holder_id = ? AND s.status = 'pending' ORDER BY s.created_at DESC
  `).all(holder.id);
  for (const split of splits) {
    split.all_splits = await db.prepare(`SELECT h.full_name, s.share_percent, s.right_type, s.status FROM splits s
      JOIN rights_holders h ON h.id = s.holder_id WHERE s.work_id = ? AND s.status <> 'rejected'`).all(split.work_id);
  }
  return res.json({ splits });
});

// POST /api/rightsholder/splits/:id/confirm  and  /reject
router.post('/splits/:id/:decision', async (req, res) => {
  const { decision } = req.params;
  if (!['confirm', 'reject'].includes(decision)) return res.status(404).json({ message: 'Unknown action.' });
  const holder = await myHolder(req);
  const split = await db.prepare('SELECT * FROM splits WHERE id = ?').get(req.params.id);
  if (!split || split.holder_id !== holder.id) return res.status(404).json({ message: 'Split not found.' });
  if (split.status !== 'pending') return res.status(409).json({ message: `This split is already ${split.status}.` });

  if (decision === 'confirm') {
    await db.prepare("UPDATE splits SET status = 'confirmed', confirmed_at = ? WHERE id = ?").run(nowIso(), split.id);
  } else {
    await db.prepare("UPDATE splits SET status = 'rejected' WHERE id = ?").run(split.id);
  }
  const status = await refreshWorkStatus(split.work_id);
  await audit.append(req.user, `${decision}_split`, 'split', split.id, { work: split.work_id, share: split.share_percent });

  // Let the person who registered the work know what happened.
  const work = await db.prepare('SELECT title, created_by FROM works WHERE id = ?').get(split.work_id);
  if (decision === 'reject') {
    await notifications.notifyUsers(work.created_by, `${holder.full_name} rejected their split on "${work.title}"`, 'Open the work and correct the splits.', 'works');
  } else if (status === 'active') {
    await notifications.notifyUsers(work.created_by, `All splits confirmed for "${work.title}"`, 'Royalties for this song will now be paid instead of held.', 'works');
  }
  return res.json({ message: decision === 'confirm' ? 'Split confirmed.' : 'Split rejected. The person who registered the work has been asked to correct it.', workStatus: status });
});

// --- Statements (FR-8) -----------------------------------------------------------

// GET /api/rightsholder/statements — every royalty line paid (or approved) to me,
// with everything needed to trace it back to the original usage.
router.get('/statements', async (req, res) => {
  const holder = await myHolder(req);
  const lines = await db.prepare(`
    SELECT rl.id, rl.amount, rl.usage_value, rl.share_percent, rl.paid_status, rl.payout_reference,
           r.id AS run_id, r.period, r.status AS run_status, r.admin_fee_rate,
           w.title AS work_title, rec.title AS recording_title, rec.isrc,
           u.played_at, u.source, u.confidence, l.name AS licensee_name, l.category AS licensee_category
    FROM royalty_lines rl
    JOIN distribution_runs r ON r.id = rl.run_id
    JOIN works w ON w.id = rl.work_id
    JOIN usage_events u ON u.id = rl.usage_id
    LEFT JOIN recordings rec ON rec.id = u.recording_id
    LEFT JOIN licensees l ON l.id = u.licensee_id
    WHERE rl.holder_id = ? AND r.status IN ('approved', 'paid')
    ORDER BY r.period DESC, u.played_at DESC
  `).all(holder.id);

  const totals = { earned: 0, paid: 0, pending: 0 };
  for (const line of lines) {
    totals.earned += Number(line.amount);
    if (line.paid_status === 'paid') totals.paid += Number(line.amount); else totals.pending += Number(line.amount);
  }

  // Money for my works that is being held because splits are not confirmed yet.
  const heldRow = await db.prepare(`
    SELECT COALESCE(SUM(rl.amount), 0) AS held FROM royalty_lines rl
    JOIN distribution_runs r ON r.id = rl.run_id
    WHERE rl.paid_status = 'held' AND r.status IN ('approved', 'paid')
      AND rl.work_id IN (SELECT work_id FROM splits WHERE holder_id = ? AND status <> 'rejected')
  `).get(holder.id);

  return res.json({ lines, totals: { ...totals, heldForMyWorks: Number(heldRow.held) } });
});

// --- Insights (charts on the artist overview) ----------------------------------------

// GET /api/rightsholder/insights
router.get('/insights', async (req, res) => {
  const holder = await myHolder(req);
  const { lastMonths, fillMonths } = require('../lib/util/periods');
  const months = lastMonths(12);

  // Works I hold a (non-rejected) share in, and my share of each.
  const myWorkIds = (await db.prepare("SELECT work_id FROM splits WHERE holder_id = ? AND status <> 'rejected'").all(holder.id)).map((r) => r.work_id);
  const inList = myWorkIds.length ? myWorkIds.map(() => '?').join(', ') : "''";

  const earningsRows = await db.prepare(`SELECT r.period AS period, SUM(rl.amount) AS value FROM royalty_lines rl
    JOIN distribution_runs r ON r.id = rl.run_id WHERE rl.holder_id = ? AND r.status IN ('approved', 'paid') AND r.period >= ? GROUP BY r.period`).all(holder.id, months[0]);
  const playsRows = await db.prepare(`SELECT u.period AS period, COUNT(*) AS value FROM usage_events u JOIN recordings rec ON rec.id = u.recording_id
    WHERE rec.work_id IN (${inList}) AND u.period >= ? GROUP BY u.period`).all(...myWorkIds, months[0]);

  const byChannel = await db.prepare(`SELECT COALESCE(l.category, 'other') AS category, COUNT(*) AS plays FROM usage_events u
    JOIN recordings rec ON rec.id = u.recording_id LEFT JOIN licensees l ON l.id = u.licensee_id
    WHERE rec.work_id IN (${inList}) GROUP BY COALESCE(l.category, 'other') ORDER BY plays DESC`).all(...myWorkIds);
  const topStations = await db.prepare(`SELECT l.name, l.category, COUNT(*) AS plays FROM usage_events u
    JOIN recordings rec ON rec.id = u.recording_id JOIN licensees l ON l.id = u.licensee_id
    WHERE rec.work_id IN (${inList}) GROUP BY l.id, l.name, l.category ORDER BY plays DESC LIMIT 5`).all(...myWorkIds);
  const topWorks = await db.prepare(`SELECT w.title, COUNT(*) AS plays FROM usage_events u JOIN recordings rec ON rec.id = u.recording_id
    JOIN works w ON w.id = rec.work_id WHERE rec.work_id IN (${inList}) GROUP BY w.id, w.title ORDER BY plays DESC LIMIT 5`).all(...myWorkIds);
  const recentPlays = await db.prepare(`SELECT u.played_at, u.source, u.confidence, rec.title, l.name AS licensee_name, l.category FROM usage_events u
    JOIN recordings rec ON rec.id = u.recording_id LEFT JOIN licensees l ON l.id = u.licensee_id
    WHERE rec.work_id IN (${inList}) ORDER BY u.played_at DESC LIMIT 8`).all(...myWorkIds);

  // Value of one play in the latest approved run — used by the earnings estimator.
  const latestRun = await db.prepare(`SELECT period, distributable, usage_count FROM distribution_runs
    WHERE status IN ('approved', 'paid') AND usage_count > 0 ORDER BY period DESC LIMIT 1`).get();
  const myShares = await db.prepare(`SELECT w.title, s.share_percent FROM splits s JOIN works w ON w.id = s.work_id
    WHERE s.holder_id = ? AND s.status <> 'rejected' ORDER BY w.title`).all(holder.id);

  res.json({
    months,
    earnings: fillMonths(months, earningsRows),
    plays: fillMonths(months, playsRows),
    byChannel, topStations, topWorks, recentPlays, myShares,
    perPlayValue: latestRun ? Math.round(Number(latestRun.distributable) / Number(latestRun.usage_count)) : null,
    perPlayPeriod: latestRun ? latestRun.period : null
  });
});

// --- Unmatched usage claims (FR-9) -----------------------------------------------

// GET /api/rightsholder/my-recordings — recordings I hold a share in (for the claim form)
router.get('/my-recordings', async (req, res) => {
  const holder = await myHolder(req);
  const recordings = await db.prepare(`
    SELECT DISTINCT rec.id, rec.title, rec.performer, rec.isrc FROM recordings rec
    JOIN splits s ON s.work_id = rec.work_id WHERE s.holder_id = ? AND s.status <> 'rejected' ORDER BY rec.title
  `).all(holder.id);
  return res.json({ recordings });
});

// POST /api/rightsholder/claims  (multipart form: usageId, recordingId, note, evidence file)
router.post('/claims', (req, res, next) => {
  evidenceUpload.single('evidence')(req, res, async (uploadError) => {
    try {
      if (uploadError) return res.status(400).json({ message: uploadError.message });
      const holder = await myHolder(req);
      const { usageId, recordingId, note } = req.body || {};

      const usage = await db.prepare('SELECT * FROM usage_events WHERE id = ?').get(usageId);
      if (!usage) return res.status(404).json({ message: 'Usage event not found.' });
      if (usage.status !== 'unmatched') return res.status(409).json({ message: 'This usage is already matched to a recording.' });

      // I can only claim for a recording of a work I hold a share in.
      const ownsRecording = await db.prepare(`SELECT 1 AS found FROM recordings rec JOIN splits s ON s.work_id = rec.work_id
        WHERE rec.id = ? AND s.holder_id = ? AND s.status <> 'rejected'`).get(recordingId, holder.id);
      if (!ownsRecording) return res.status(403).json({ message: 'You can only claim usage for recordings of your own works.' });

      const duplicate = await db.prepare("SELECT 1 AS found FROM usage_claims WHERE usage_id = ? AND claimant_user_id = ? AND status = 'pending'").get(usageId, req.user.id);
      if (duplicate) return res.status(409).json({ message: 'You already have a pending claim for this usage.' });

      const claimId = newId('CLM');
      await db.prepare(`INSERT INTO usage_claims (id, usage_id, claimant_user_id, recording_id, note, evidence_file, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(claimId, usageId, req.user.id, recordingId, note ? String(note).slice(0, 1000) : null, req.file ? req.file.filename : null, 'pending', nowIso());
      await audit.append(req.user, 'claim_usage', 'usage_claim', claimId, { usageId, recordingId });
      await notifications.notifyRoles(['admin'], 'New claim on an unmatched play', `${holder.full_name} claims "${usage.raw_title || 'an unknown title'}".`, 'claims');
      return res.status(201).json({ message: 'Claim submitted. The administrator will review it.', claimId });
    } catch (error) {
      return next(error);
    }
  });
});

// GET /api/rightsholder/claims — my claims
router.get('/claims', async (req, res) => {
  const claims = await db.prepare(`
    SELECT c.*, u.raw_title, u.raw_artist, u.played_at, u.source, rec.title AS recording_title
    FROM usage_claims c JOIN usage_events u ON u.id = c.usage_id JOIN recordings rec ON rec.id = c.recording_id
    WHERE c.claimant_user_id = ? ORDER BY c.created_at DESC
  `).all(req.user.id);
  return res.json({ claims });
});

module.exports = router;
