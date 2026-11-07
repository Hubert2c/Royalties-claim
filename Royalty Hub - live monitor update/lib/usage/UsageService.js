// =============================================================================
// lib/usage/UsageService.js — record plays and match them to registered songs
// -----------------------------------------------------------------------------
// Plays arrive from many sources (Table 7 of the document):
//   fingerprint — a radio/TV monitor heard the song
//   play_log    — a station's monthly play log
//   set_list    — songs performed at a concert
//   cue_sheet   — songs used in an advert or TV programme
//   ddex        — a digital service's usage report
//   simulation  — the demo "Simulate airplay" button
//
// Each row is matched by UsageMatcher (fingerprint -> ISRC -> title). Rows that
// match nothing are still saved, as "unmatched", and appear on the public
// unclaimed list where the owner can claim them (FR-9).
// =============================================================================

const { UsageMatcher } = require('./MatchStrategies');
const { ValidationError } = require('../errors');

class UsageService {
  static SOURCES = ['fingerprint', 'play_log', 'set_list', 'cue_sheet', 'ddex', 'simulation'];

  /** Sources a music user may report itself (the others come from monitors / the demo). */
  static REPORTABLE_SOURCES = ['play_log', 'set_list', 'cue_sheet', 'ddex'];

  /**
   * @param {object} deps
   * @param {object} deps.db
   * @param {Function} deps.newId
   * @param {Function} deps.nowIso
   * @param {UsageMatcher} [deps.matcher]
   */
  constructor({ db, newId, nowIso, matcher = new UsageMatcher() }) {
    this.db = db;
    this.newId = newId;
    this.nowIso = nowIso;
    this.matcher = matcher;
  }

  /** Throw a ValidationError unless the source is one a music user may send. */
  static assertReportable(source) {
    if (!UsageService.REPORTABLE_SOURCES.includes(source)) {
      throw new ValidationError('Source must be play_log, set_list, cue_sheet or ddex.');
    }
  }

  /** Check one row; returns an error message or null. */
  static validateRow(row, index) {
    const playedAt = new Date(row.played_at || Date.now());
    if (Number.isNaN(playedAt.getTime())) return `Row ${index + 1}: "played_at" is not a valid date.`;
    if (!row.fingerprint && !row.isrc && !row.title) return `Row ${index + 1}: give at least a title, an ISRC or a fingerprint.`;
    return null;
  }

  /**
   * Save a batch of plays for one music user.
   * @param {{licenseeId: string|null, source: string, rows: object[]}} batch
   * @returns {Promise<{saved, matched, unmatched, errors: string[], events: object[]}>}
   */
  async record({ licenseeId, source, rows }) {
    if (!UsageService.SOURCES.includes(source)) throw new ValidationError(`Unknown usage source "${source}".`);
    if (!Array.isArray(rows) || rows.length === 0) throw new ValidationError('No usage rows were provided.');
    if (rows.length > 5000) throw new ValidationError('Please send at most 5,000 rows at a time.');

    // Load the catalogue once per batch, not once per row.
    const catalogue = await this.db.prepare('SELECT id, work_id, title, performer, isrc, fingerprint FROM recordings').all();
    const summary = { saved: 0, matched: 0, unmatched: 0, errors: [], events: [] };

    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i] || {};
      const problem = UsageService.validateRow(row, i);
      if (problem) { summary.errors.push(problem); continue; }

      const match = this.matcher.match(row, catalogue);
      const event = await this.saveEvent(licenseeId, source, row, match);
      summary.saved += 1;
      if (match) summary.matched += 1; else summary.unmatched += 1;
      summary.events.push(event);
    }
    return summary;
  }

  /**
   * Record ONE detection from a live monitor (a few seconds of broadcast audio).
   *
   * A live monitor sends a clip every 10-15 seconds, so a 3-minute song arrives
   * as about 12 detections. Counting each one as a play would pay the song 12
   * times. Real monitoring services merge back-to-back detections of the same
   * song into one play, and so do we:
   *
   *   if the station's previous fingerprint play was the SAME song (or was also
   *   unidentified) and it ended at most `mergeGapSec` seconds before this clip
   *   started, we extend that play instead of creating a new one.
   *
   * @param {{licenseeId: string, row: object, mergeGapSec?: number}} detection
   * @returns {Promise<{event: object|null, merged: boolean, errors: string[]}>}
   */
  async recordDetection({ licenseeId, row, mergeGapSec = 60 }) {
    const problem = UsageService.validateRow(row || {}, 0);
    if (problem) return { event: null, merged: false, errors: [problem] };

    // 1. Identify the clip against the catalogue (same matching as record()).
    const catalogue = await this.db.prepare('SELECT id, work_id, title, performer, isrc, fingerprint FROM recordings').all();
    const match = this.matcher.match(row, catalogue);
    const recordingId = match ? match.recording.id : null;

    // 2. Find this station's most recent fingerprint play.
    const clipStart = new Date(row.played_at || Date.now());
    const clipSeconds = Number(row.duration_sec) > 0 ? Number(row.duration_sec) : 0;
    const previous = licenseeId
      ? await this.db.prepare(`SELECT id, recording_id, played_at, duration_sec, confidence, raw_title FROM usage_events
          WHERE licensee_id = ? AND source = 'fingerprint' ORDER BY played_at DESC LIMIT 1`).get(licenseeId)
      : null;

    if (previous) {
      const previousStart = new Date(previous.played_at);
      const previousEnd = new Date(previousStart.getTime() + (Number(previous.duration_sec) || 0) * 1000);
      const gapSeconds = (clipStart - previousEnd) / 1000;
      const sameSong = (previous.recording_id || null) === recordingId; // null === null means "both unidentified"

      // 3. Same song, still playing (or only a short gap): extend the existing play.
      if (sameSong && clipStart >= previousStart && gapSeconds <= mergeGapSec) {
        const newEnd = Math.max(previousEnd.getTime(), clipStart.getTime() + clipSeconds * 1000);
        const totalSeconds = Math.round((newEnd - previousStart.getTime()) / 1000);
        const bestConfidence = match ? Math.max(Number(previous.confidence) || 0, match.confidence) : previous.confidence;
        await this.db.prepare('UPDATE usage_events SET duration_sec = ?, confidence = ? WHERE id = ?')
          .run(totalSeconds, bestConfidence, previous.id);
        return {
          merged: true,
          errors: [],
          event: {
            id: previous.id,
            matched: Boolean(recordingId),
            recording_id: recordingId,
            title: match ? match.recording.title : previous.raw_title,
            confidence: match ? match.confidence : null,
            duration_sec: totalSeconds
          }
        };
      }
    }

    // 4. A new song (or a long silence since the last one): save a new play.
    const event = await this.saveEvent(licenseeId, 'fingerprint', row, match);
    return { event: { ...event, duration_sec: clipSeconds ? Math.round(clipSeconds) : null }, merged: false, errors: [] };
  }

  /** Insert one usage event and return a short summary of it. */
  async saveEvent(licenseeId, source, row, match) {
    const id = this.newId('USE');
    const recording = match ? match.recording : null;
    const playedAt = new Date(row.played_at || Date.now()).toISOString();
    const clip = (value) => (value ? String(value).slice(0, 200) : null);

    await this.db.prepare(`INSERT INTO usage_events (id, licensee_id, recording_id, source, raw_title, raw_artist, isrc, played_at,
        period, duration_sec, confidence, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        id,
        licenseeId || null,
        recording ? recording.id : null,
        source,
        clip(row.title) || (recording ? recording.title : null),
        clip(row.artist) || (recording ? recording.performer : null),
        row.isrc ? String(row.isrc).trim().toUpperCase() : (recording ? recording.isrc : null),
        playedAt,
        playedAt.slice(0, 7),
        Number.isFinite(Number(row.duration_sec)) && row.duration_sec !== undefined ? Math.round(Number(row.duration_sec)) : null,
        match ? match.confidence : null,
        recording ? 'matched' : 'unmatched',
        this.nowIso()
      );

    return {
      id,
      matched: Boolean(recording),
      recording_id: recording ? recording.id : null,
      title: recording ? recording.title : row.title || null,
      confidence: match ? match.confidence : null,
      method: match ? match.method : null
    };
  }
}

module.exports = { UsageService };
