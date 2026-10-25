// =============================================================================
// lib/fingerprint/DemoFingerprints.js — synthetic fingerprints for the demo
// -----------------------------------------------------------------------------
// Real deployments get fingerprints from `fpcalc -raw` (see tools/monitor-report.js).
// For the demo data and the "Simulate airplay" button we need fingerprints that
// behave like real ones: stable per song, and a noisy copy for a radio clip.
// =============================================================================

class DemoFingerprints {
  /** Small deterministic pseudo-random generator (mulberry32): same seed, same numbers. */
  static seededRandom(seed) {
    let state = seed >>> 0;
    return function next() {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0);
    };
  }

  /** A fake but stable "fingerprint" for a demo recording. */
  static synthetic(seed, length = 240) {
    const next = DemoFingerprints.seededRandom(seed);
    return Array.from({ length }, () => next());
  }

  /**
   * Cut a piece out of a fingerprint and flip random bits in every value, to
   * imitate a few seconds of the song captured from a noisy radio stream.
   */
  static noisySample(fingerprint, start = 20, length = 60, flippedBitsPerValue = 4) {
    return fingerprint.slice(start, start + length).map((value) => {
      let noisy = value;
      for (let i = 0; i < flippedBitsPerValue; i += 1) {
        noisy ^= 1 << Math.floor(Math.random() * 32);
      }
      return noisy >>> 0;
    });
  }
}

module.exports = { DemoFingerprints };
