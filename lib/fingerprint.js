// =============================================================================
// lib/fingerprint.js — identify broadcast songs by audio fingerprint
// -----------------------------------------------------------------------------
// How it works (Chapter 2.2.5 and Table 7 of the document):
//
// 1. Every registered recording stores a Chromaprint "raw" fingerprint: a list
//    of 32-bit integers produced by the open-source tool `fpcalc -raw`.
//    Each integer describes a short slice (~0.12 s) of the audio.
// 2. A radio monitor records a few seconds of a station's stream, runs
//    `fpcalc -raw` on it, and sends that (shorter) list to the platform.
// 3. We slide the short list along each registered fingerprint and count how
//    many bits differ (the "bit error rate", BER). Two unrelated songs differ
//    in about half of their bits (BER ≈ 0.5). The same song, even with radio
//    noise, differs in far fewer bits.
// 4. confidence = 1 − best BER. If confidence ≥ MATCH_THRESHOLD we have a match.
//
// This is the same idea used by AcoustID/Chromaprint, kept deliberately simple
// (a brute-force search) because the prototype has a small catalogue.
// =============================================================================

// A match needs at least 65% of bits to agree (BER ≤ 0.35).
const MATCH_THRESHOLD = 0.65;

// Count the 1-bits in a 32-bit integer ("population count").
function popcount32(value) {
  let v = value >>> 0;
  v -= (v >>> 1) & 0x55555555;
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

// Turn "123,456,..." (or an array) into an array of unsigned 32-bit integers.
function parseFingerprint(input) {
  if (!input) return [];
  const parts = Array.isArray(input) ? input : String(input).split(',');
  return parts
    .map((part) => Number(String(part).trim()))
    .filter((num) => Number.isFinite(num))
    .map((num) => num >>> 0);
}

// Compare a short "sample" with a longer "reference" at every possible offset.
// Returns { confidence, offset } for the best alignment.
function compareFingerprints(sample, reference) {
  if (!sample.length || !reference.length) return { confidence: 0, offset: -1 };

  // If the sample is longer than the reference, swap them so we slide the shorter one.
  const shortFp = sample.length <= reference.length ? sample : reference;
  const longFp = sample.length <= reference.length ? reference : sample;

  let bestBer = 1;
  let bestOffset = -1;
  for (let offset = 0; offset <= longFp.length - shortFp.length; offset += 1) {
    let differentBits = 0;
    for (let i = 0; i < shortFp.length; i += 1) {
      differentBits += popcount32(shortFp[i] ^ longFp[offset + i]);
    }
    const ber = differentBits / (shortFp.length * 32);
    if (ber < bestBer) {
      bestBer = ber;
      bestOffset = offset;
    }
  }
  return { confidence: Number((1 - bestBer).toFixed(4)), offset: bestOffset };
}

// Find the best-matching recording in the catalogue.
// recordings: [{ id, fingerprint: "1,2,3..." , ... }]
function identify(sampleInput, recordings) {
  const sample = parseFingerprint(sampleInput);
  let best = null;
  for (const recording of recordings) {
    const reference = parseFingerprint(recording.fingerprint);
    if (!reference.length) continue;
    const result = compareFingerprints(sample, reference);
    if (!best || result.confidence > best.confidence) {
      best = { recording, confidence: result.confidence, offset: result.offset };
    }
  }
  if (best && best.confidence >= MATCH_THRESHOLD) {
    return { matched: true, ...best };
  }
  return { matched: false, confidence: best ? best.confidence : 0, recording: null };
}

// -----------------------------------------------------------------------------
// Demo helpers (used for seeding and for the "simulate airplay" button).
// Real deployments get fingerprints from `fpcalc -raw` instead.
// -----------------------------------------------------------------------------

// Small deterministic pseudo-random generator (mulberry32).
function seededRandom(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0);
  };
}

// A fake but stable "fingerprint" for a demo recording.
function syntheticFingerprint(seed, length = 240) {
  const next = seededRandom(seed);
  return Array.from({ length }, () => next());
}

// Cut a piece out of a fingerprint and flip some random bits, to imitate a few
// seconds of the song captured from a noisy radio stream.
function noisySample(fingerprint, start = 20, length = 60, flippedBitsPerValue = 4) {
  const piece = fingerprint.slice(start, start + length);
  return piece.map((value) => {
    let noisy = value;
    for (let i = 0; i < flippedBitsPerValue; i += 1) {
      noisy ^= 1 << Math.floor(Math.random() * 32);
    }
    return noisy >>> 0;
  });
}

module.exports = {
  MATCH_THRESHOLD,
  popcount32,
  parseFingerprint,
  compareFingerprints,
  identify,
  syntheticFingerprint,
  noisySample
};
