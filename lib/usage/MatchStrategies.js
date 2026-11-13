// =============================================================================
// lib/usage/MatchStrategies.js — how a reported play is matched to a song
// -----------------------------------------------------------------------------
// Strategy pattern (polymorphism): each way of recognising a song is its own
// class with the same two methods:
//
//     canHandle(row)          -> does this row carry what I need?
//     match(row, catalogue)  -> { recording, confidence } or null
//
// UsageMatcher tries the strategies in order of reliability:
//   1. FingerprintMatchStrategy  — the audio itself (radio/TV monitors)
//   2. IsrcMatchStrategy         — the recording's international code
//   3. TitleArtistMatchStrategy  — title + performer, ignoring upper/lower case
//
// A fingerprint is "exclusive": if a row carries one, the sound decides on its
// own and we do not fall back to the (less reliable) title. Adding a new method
// later (for example fuzzy title matching) means adding one class — the
// matcher and its callers do not change (open/closed principle).
// =============================================================================

const { FingerprintMatcher } = require('../fingerprint/FingerprintMatcher');

/** Base class: every strategy must implement canHandle() and match(). */
class MatchStrategy {
  constructor() {
    if (new.target === MatchStrategy) throw new TypeError('MatchStrategy is abstract; use a subclass.');
  }

  /** Short name stored for reports and tests. */
  get name() { throw new Error('Subclasses must define name.'); }

  /** If true, the matcher stops after this strategy even when it finds nothing. */
  get exclusive() { return false; }

  canHandle(row) { throw new Error(`${this.constructor.name} must implement canHandle(${typeof row}).`); }

  match(row, catalogue) { throw new Error(`${this.constructor.name} must implement match(${typeof row}, ${typeof catalogue}).`); }
}

class FingerprintMatchStrategy extends MatchStrategy {
  /** @param {FingerprintMatcher} [matcher] */
  constructor(matcher = new FingerprintMatcher()) {
    super();
    this.matcher = matcher;
  }

  get name() { return 'fingerprint'; }

  get exclusive() { return true; }

  canHandle(row) { return Boolean(row.fingerprint); }

  match(row, catalogue) {
    const result = this.matcher.identify(row.fingerprint, catalogue);
    return result.matched ? { recording: result.recording, confidence: result.confidence } : null;
  }
}

class IsrcMatchStrategy extends MatchStrategy {
  get name() { return 'isrc'; }

  canHandle(row) { return Boolean(row.isrc); }

  match(row, catalogue) {
    const isrc = String(row.isrc).trim().toUpperCase();
    const recording = catalogue.find((rec) => rec.isrc && rec.isrc.toUpperCase() === isrc);
    return recording ? { recording, confidence: 1 } : null;
  }
}

class TitleArtistMatchStrategy extends MatchStrategy {
  get name() { return 'title'; }

  canHandle(row) { return Boolean(row.title); }

  match(row, catalogue) {
    const title = String(row.title).trim().toLowerCase();
    const artist = String(row.artist || '').trim().toLowerCase();
    const recording = catalogue.find((rec) => rec.title.toLowerCase() === title
      && (!artist || String(rec.performer || '').toLowerCase() === artist));
    return recording ? { recording, confidence: 1 } : null;
  }
}

/** Runs the strategies in order and returns the first match. */
class UsageMatcher {
  /** @param {MatchStrategy[]} [strategies] */
  constructor(strategies = [new FingerprintMatchStrategy(), new IsrcMatchStrategy(), new TitleArtistMatchStrategy()]) {
    this.strategies = strategies;
  }

  /**
   * @param {object} row - one reported play
   * @param {object[]} catalogue - registered recordings
   * @returns {{recording: object, confidence: number, method: string}|null}
   */
  match(row, catalogue) {
    for (const strategy of this.strategies) {
      if (!strategy.canHandle(row)) continue;
      const found = strategy.match(row, catalogue);
      if (found) return { ...found, method: strategy.name };
      if (strategy.exclusive) return null;
    }
    return null;
  }
}

module.exports = { MatchStrategy, FingerprintMatchStrategy, IsrcMatchStrategy, TitleArtistMatchStrategy, UsageMatcher };
