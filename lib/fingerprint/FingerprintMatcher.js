// =============================================================================
// lib/fingerprint/FingerprintMatcher.js — identify broadcast songs by their sound
// -----------------------------------------------------------------------------
// How it works (Chapter 2.2.5 and Table 7 of the document):
//
// 1. Every registered recording stores a Chromaprint "raw" fingerprint: a list
//    of 32-bit integers made by the open-source tool `fpcalc -raw`. Each integer
//    describes about 0.12 s of audio.
// 2. A radio monitor records a few seconds of a station, runs `fpcalc -raw`, and
//    sends that shorter list to the platform.
// 3. ALGORITHM — sliding bit-error-rate search:
//    slide the short list along each registered fingerprint; at each position,
//    XOR the integers and count the bits that differ (popcount). The share of
//    different bits is the "bit error rate" (BER). Two unrelated songs differ in
//    about half their bits (BER ≈ 0.5); the same song with radio noise differs
//    in far fewer.
// 4. confidence = 1 − best BER. A match needs confidence ≥ 0.65.
//
// Complexity: O(R × L × S) for R recordings, reference length L and sample
// length S. Fine for a national catalogue in the prototype; at scale the same
// class can be put behind an index (e.g. AcoustID-style hashing) without
// changing its callers.
// =============================================================================

class FingerprintMatcher {
  /** A match needs at least 65% of the bits to agree (BER ≤ 0.35). */
  static DEFAULT_THRESHOLD = 0.65;

  /** @param {{threshold?: number}} [options] */
  constructor({ threshold = FingerprintMatcher.DEFAULT_THRESHOLD } = {}) {
    this.threshold = threshold;
    // Performance (found by the load test): registered fingerprints are stored
    // as text, and parsing them on every request was wasted work. Parsed
    // references are kept here, keyed by the stored text (so an edited
    // fingerprint is parsed again). Uint32Array also makes the XOR loop faster.
    this.referenceCache = new Map();
  }

  /** Parsed reference fingerprint, from the cache when possible. */
  reference(text) {
    let parsed = this.referenceCache.get(text);
    if (!parsed) {
      parsed = Uint32Array.from(FingerprintMatcher.parse(text));
      if (this.referenceCache.size > 50000) this.referenceCache.clear(); // simple memory bound
      this.referenceCache.set(text, parsed);
    }
    return parsed;
  }

  /** Count the 1-bits in a 32-bit integer (SWAR population count, no loops). */
  static popcount32(value) {
    let v = value >>> 0;
    v -= (v >>> 1) & 0x55555555;
    v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
    return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
  }

  /** Turn "123,456,..." (or an array) into unsigned 32-bit integers. */
  static parse(input) {
    if (!input) return [];
    const parts = Array.isArray(input) ? input : String(input).split(',');
    return parts
      .map((part) => Number(String(part).trim()))
      .filter((num) => Number.isFinite(num))
      .map((num) => num >>> 0);
  }

  /**
   * Compare a sample with a reference at every offset.
   * @returns {{confidence: number, offset: number}} the best alignment
   */
  compare(sample, reference) {
    if (!sample.length || !reference.length) return { confidence: 0, offset: -1 };

    // Always slide the shorter list along the longer one.
    const shortFp = sample.length <= reference.length ? sample : reference;
    const longFp = sample.length <= reference.length ? reference : sample;

    let bestBer = 1;
    let bestOffset = -1;
    for (let offset = 0; offset <= longFp.length - shortFp.length; offset += 1) {
      let differentBits = 0;
      for (let i = 0; i < shortFp.length; i += 1) {
        differentBits += FingerprintMatcher.popcount32(shortFp[i] ^ longFp[offset + i]);
      }
      const ber = differentBits / (shortFp.length * 32);
      if (ber < bestBer) {
        bestBer = ber;
        bestOffset = offset;
      }
    }
    return { confidence: Number((1 - bestBer).toFixed(4)), offset: bestOffset };
  }

  /**
   * Find the best-matching recording in a catalogue.
   * @param {string|number[]} sampleInput - the monitor's fingerprint
   * @param {{id: string, fingerprint: string}[]} recordings
   * @returns {{matched: boolean, confidence: number, recording: object|null, offset?: number}}
   */
  identify(sampleInput, recordings) {
    const sample = Uint32Array.from(FingerprintMatcher.parse(sampleInput));
    let best = null;
    for (const recording of recordings) {
      if (!recording.fingerprint) continue;
      const reference = this.reference(recording.fingerprint);
      if (!reference.length) continue;
      const result = this.compare(sample, reference);
      if (!best || result.confidence > best.confidence) {
        best = { recording, confidence: result.confidence, offset: result.offset };
      }
    }
    if (best && best.confidence >= this.threshold) return { matched: true, ...best };
    return { matched: false, confidence: best ? best.confidence : 0, recording: null };
  }
}

module.exports = { FingerprintMatcher };
