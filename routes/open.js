// =============================================================================
// routes/open.js — the Open API (version 1) for machines, not people
// -----------------------------------------------------------------------------
// FR-13 and the ONDC lesson in Section 2.2.6: the government owns the registry,
// rules and audit trail, and publishes standard APIs so that OTHER systems can
// plug in — broadcast playout systems, radio monitoring services, ticketing
// apps, telecoms, streaming services.
//
// Authentication: an API key in the "X-API-Key" header.
//   * licensee keys  — report usage for that licensee only
//   * monitor keys   — issued by the government to a monitoring service; must
//                      say which station (licensee) each report is for
// The human-readable documentation is served at /docs.
// =============================================================================

const express = require('express');
const { db } = require('../database');
const { audit, usage: usageService } = require('../lib/services');
const { apiKeyRequired } = require('../lib/security/auth');
const { UsageService } = require('../lib/usage/UsageService');
const { JsonUsageParser } = require('../lib/usage/ReportParsers');
const { ValidationError } = require('../lib/errors');

const router = express.Router();
router.use(apiKeyRequired);

// Work out which licensee a request is for, based on the key type.
async function resolveLicensee(req, stationId) {
  if (req.apiKey.owner_type === 'licensee') return req.apiKey.owner_id;
  if (!stationId) throw new ValidationError('Monitor keys must send "station_id" (the licensee ID of the station).');
  const station = await db.prepare('SELECT id FROM licensees WHERE id = ?').get(stationId);
  if (!station) throw new ValidationError(`Unknown station_id "${stationId}".`);
  return station.id;
}

const actorFor = (req) => ({ id: `api-key:${req.apiKey.id}`, role: `api_${req.apiKey.owner_type}` });

// POST /api/open/v1/usage
// Body: { source: "play_log"|"set_list"|"cue_sheet"|"ddex", station_id?, events: [{ played_at, title, artist, isrc, duration_sec }] }
router.post('/usage', async (req, res) => {
  try {
    const { source = 'play_log', station_id: stationId, events } = req.body || {};
    UsageService.assertReportable(source);
    const licenseeId = await resolveLicensee(req, stationId);
    const summary = await usageService.record({ licenseeId, source, rows: new JsonUsageParser().parse(events) });
    await audit.append(actorFor(req), 'open_api_usage', 'usage_events', null, { licenseeId, source, saved: summary.saved, matched: summary.matched });
    return res.status(201).json({ saved: summary.saved, matched: summary.matched, unmatched: summary.unmatched, errors: summary.errors, events: summary.events });
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }
});

// POST /api/open/v1/fingerprint-matches
// Body: { station_id?, played_at, duration_sec, fingerprint: [int, int, ...] or "int,int,..." }
// The fingerprint is the output of `fpcalc -raw` on a few seconds of broadcast audio.
router.post('/fingerprint-matches', async (req, res) => {
  try {
    const { station_id: stationId, played_at: playedAt, duration_sec: durationSec, fingerprint } = req.body || {};
    if (!fingerprint) return res.status(400).json({ message: 'fingerprint is required.' });
    const licenseeId = await resolveLicensee(req, stationId);
    const summary = await usageService.record({ licenseeId, source: 'fingerprint', rows: [{ fingerprint, played_at: playedAt, duration_sec: durationSec }] });
    const event = summary.events[0];
    await audit.append(actorFor(req), 'open_api_fingerprint', 'usage_events', event ? event.id : null, { licenseeId, matched: summary.matched });
    return res.status(201).json({ usage_id: event ? event.id : null, matched: Boolean(event && event.matched), recording_id: event ? event.recording_id : null, title: event ? event.title : null, confidence: event ? event.confidence : null, errors: summary.errors });
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }
});

// GET /api/open/v1/catalogue — registered recordings (for matching by ISRC on the client side)
router.get('/catalogue', async (req, res) => {
  const recordings = await db.prepare('SELECT r.id, r.title, r.performer, r.isrc, r.duration_sec, w.iswc FROM recordings r JOIN works w ON w.id = r.work_id ORDER BY r.title').all();
  res.json({ recordings });
});

module.exports = router;
