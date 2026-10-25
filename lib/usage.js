// =============================================================================
// lib/usage.js — record music usage and match it to registered recordings
// -----------------------------------------------------------------------------
// Usage arrives from many places (Table 7 of the document):
//   fingerprint — a radio/TV monitor sends an audio fingerprint of what it heard
//   play_log    — a station uploads its monthly play log
//   set_list    — a concert organiser lists the songs performed
//   cue_sheet   — an advertiser lists the songs in an advert
//   ddex        — a streaming service / telecom sends a usage report
//
// Every row is matched to a recording in this order:
//   1. audio fingerprint (if one was sent)
//   2. ISRC code (exact)
//   3. title + performer (exact, ignoring upper/lower case)
// Rows that match nothing are saved as "unmatched" and appear on the public
// unclaimed list, where rights holders can claim them (FR-9).
// =============================================================================

const { db, newId, nowIso } = require('../database');
const { identify } = require('./fingerprint');

const SOURCES = ['fingerprint', 'play_log', 'set_list', 'cue_sheet', 'ddex', 'simulation'];

// Find the recording for one usage row. Returns { recording, confidence } or null.
async function matchRow(row, catalogue) {
  if (row.fingerprint) {
    const result = identify(row.fingerprint, catalogue);
    if (result.matched) return { recording: result.recording, confidence: result.confidence };
    return null;
  }
  if (row.isrc) {
    const recording = catalogue.find((rec) => rec.isrc && rec.isrc.toUpperCase() === String(row.isrc).trim().toUpperCase());
    if (recording) return { recording, confidence: 1 };
  }
  if (row.title) {
    const title = String(row.title).trim().toLowerCase();
    const artist = String(row.artist || '').trim().toLowerCase();
    const recording = catalogue.find((rec) => rec.title.toLowerCase() === title
      && (!artist || String(rec.performer || '').toLowerCase() === artist));
    if (recording) return { recording, confidence: 1 };
  }
  return null;
}

// Save a batch of usage rows for one licensee.
// rows: [{ played_at, title, artist, isrc, duration_sec, fingerprint }]
// Returns { saved, matched, unmatched, errors: [...] }
async function recordUsage({ licenseeId, source, rows }) {
  if (!SOURCES.includes(source)) throw new Error(`Unknown usage source "${source}".`);
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('No usage rows were provided.');
  if (rows.length > 5000) throw new Error('Please send at most 5,000 rows at a time.');

  const catalogue = await db.prepare('SELECT id, work_id, title, performer, isrc, fingerprint FROM recordings').all();
  const summary = { saved: 0, matched: 0, unmatched: 0, errors: [], events: [] };

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i] || {};
    const playedAt = new Date(row.played_at || Date.now());
    if (Number.isNaN(playedAt.getTime())) {
      summary.errors.push(`Row ${i + 1}: "played_at" is not a valid date.`);
      continue;
    }
    if (!row.fingerprint && !row.isrc && !row.title) {
      summary.errors.push(`Row ${i + 1}: give at least a title, an ISRC or a fingerprint.`);
      continue;
    }

    const match = await matchRow(row, catalogue);
    const id = newId('USE');
    const recording = match ? match.recording : null;

    await db.prepare(`INSERT INTO usage_events (id, licensee_id, recording_id, source, raw_title, raw_artist, isrc, played_at,
        period, duration_sec, confidence, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        id,
        licenseeId || null,
        recording ? recording.id : null,
        source,
        row.title ? String(row.title).slice(0, 200) : (recording ? recording.title : null),
        row.artist ? String(row.artist).slice(0, 200) : (recording ? recording.performer : null),
        row.isrc ? String(row.isrc).trim().toUpperCase() : (recording ? recording.isrc : null),
        playedAt.toISOString(),
        playedAt.toISOString().slice(0, 7),
        Number.isFinite(Number(row.duration_sec)) ? Math.round(Number(row.duration_sec)) : null,
        match ? match.confidence : null,
        recording ? 'matched' : 'unmatched',
        nowIso()
      );

    summary.saved += 1;
    if (recording) summary.matched += 1; else summary.unmatched += 1;
    summary.events.push({ id, matched: Boolean(recording), recording_id: recording ? recording.id : null, title: recording ? recording.title : row.title || null, confidence: match ? match.confidence : null });
  }
  return summary;
}

module.exports = { SOURCES, recordUsage, matchRow };
