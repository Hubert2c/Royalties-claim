// =============================================================================
// tests/performance/algorithm-benchmark.js — how do the algorithms scale?
// -----------------------------------------------------------------------------
//   1. Fingerprint matching vs. catalogue size (expected: linear, O(R × L × S)),
//      with the parsed-fingerprint cache cold and warm.
//   2. Largest-remainder money allocation vs. number of shares (O(n log n)).
//   3. Royalty calculation for a whole month vs. number of plays.
//   4. Audit-chain verification vs. number of entries (O(n)).
//
// Run with:  npm run test:bench
// Results:   tests/performance/results/algorithm-benchmark.json and .md
// =============================================================================

const fs = require('fs');
const os = require('os');
const path = require('path');
const { performance } = require('perf_hooks');

process.env.SKIP_SEED = 'true';
const { FingerprintMatcher } = require('../../lib/fingerprint/FingerprintMatcher');
const { DemoFingerprints } = require('../../lib/fingerprint/DemoFingerprints');
const { MoneyAllocator } = require('../../lib/money/MoneyAllocator');
const { RoyaltyEngine } = require('../../lib/royalties/RoyaltyEngine');
const { AuditLog } = require('../../lib/audit/AuditLog');
const { SqliteAdapter } = require('../../db/adapters');
const { SCHEMA } = require('../../db/schema');

const RESULTS = path.join(__dirname, 'results');

/** Average milliseconds of `fn` over `repeat` runs. */
function time(fn, repeat = 5) {
  fn(); // warm-up
  const start = performance.now();
  for (let i = 0; i < repeat; i += 1) fn();
  return (performance.now() - start) / repeat;
}

async function main() {
  fs.mkdirSync(RESULTS, { recursive: true });
  const results = { date: new Date().toISOString(), machine: `${os.cpus()[0].model}, ${os.cpus().length} cores, Node ${process.version}` };

  // 1. Fingerprint matching: a 60-value clip (~7 s of audio) against R songs of 240 values (~30 s).
  results.fingerprint = [];
  for (const size of [10, 100, 1000, 5000]) {
    const catalogue = Array.from({ length: size }, (_, i) => ({ id: `R${i}`, fingerprint: DemoFingerprints.synthetic(i + 1, 240).join(',') }));
    const clip = DemoFingerprints.noisySample(DemoFingerprints.synthetic(size, 240), 100, 60, 4);
    const cold = time(() => new FingerprintMatcher().identify(clip, catalogue), 3);
    const matcher = new FingerprintMatcher();
    const warm = time(() => matcher.identify(clip, catalogue), 3);
    const found = matcher.identify(clip, catalogue);
    results.fingerprint.push({ recordings: size, coldMs: +cold.toFixed(2), warmMs: +warm.toFixed(2), matched: found.matched && found.recording.id === `R${size - 1}`, confidence: found.confidence });
  }

  // 1b. Matching ACCURACY (proposal target: precision of at least 90%).
  // 300 noisy clips of registered songs + 300 clips of songs that are NOT registered,
  // against a catalogue of 1,000 songs. Noise: 3-6 flipped bits in every 32-bit value.
  {
    const catalogue = Array.from({ length: 1000 }, (_, i) => ({ id: `R${i}`, fingerprint: DemoFingerprints.synthetic(i + 1, 240).join(',') }));
    const matcher = new FingerprintMatcher();
    let tp = 0; let fp = 0; let fn = 0; let tn = 0;
    for (let i = 0; i < 300; i += 1) {
      const songIndex = (i * 37) % 1000;
      const clip = DemoFingerprints.noisySample(DemoFingerprints.synthetic(songIndex + 1, 240), (i * 7) % 170, 60, 3 + (i % 4));
      const result = matcher.identify(clip, catalogue);
      if (result.matched && result.recording.id === `R${songIndex}`) tp += 1; else if (result.matched) fp += 1; else fn += 1;
      const stranger = DemoFingerprints.noisySample(DemoFingerprints.synthetic(100000 + i, 240), 50, 60, 3);
      if (matcher.identify(stranger, catalogue).matched) fp += 1; else tn += 1;
    }
    results.accuracy = { clips: 600, catalogue: 1000, truePositives: tp, falsePositives: fp, falseNegatives: fn, trueNegatives: tn,
      precision: +(tp / Math.max(tp + fp, 1)).toFixed(4), recall: +(tp / Math.max(tp + fn, 1)).toFixed(4) };
  }

  // 2. Money allocation.
  results.allocation = [];
  for (const n of [10, 1000, 100000, 1000000]) {
    const weights = Array.from({ length: n }, (_, i) => 1 + (i % 97));
    const ms = time(() => MoneyAllocator.allocate(987654321, weights), 3);
    const parts = MoneyAllocator.allocate(987654321, weights);
    results.allocation.push({ shares: n, ms: +ms.toFixed(2), exact: parts.reduce((a, b) => a + b, 0) === 987654321 });
  }

  // 3. A month's royalty calculation: P plays over 500 songs with 2 writers each.
  results.royalties = [];
  const splitsByWork = {};
  for (let w = 0; w < 500; w += 1) {
    splitsByWork[`W${w}`] = [{ holder_id: `A${w}`, share_percent: 60, status: 'confirmed' }, { holder_id: `B${w}`, share_percent: 40, status: w % 10 ? 'confirmed' : 'pending' }];
  }
  const engine = new RoyaltyEngine();
  for (const plays of [1000, 10000, 100000]) {
    const usage = Array.from({ length: plays }, (_, i) => ({ id: `U${i}`, work_id: `W${i % 500}` }));
    const ms = time(() => engine.calculate({ pool: 250000000, usage, splitsByWork }, 0.15), 3);
    const r = engine.calculate({ pool: 250000000, usage, splitsByWork }, 0.15);
    const paid = r.lines.filter((l) => l.status !== 'held').reduce((s, l) => s + l.amount, 0);
    results.royalties.push({ plays, lines: r.lines.length, ms: +ms.toFixed(1), balanced: r.adminFee + paid + r.held === 250000000 });
  }

  // 4. Audit-chain verification on a real (in-memory) database.
  results.audit = [];
  for (const n of [1000, 10000]) {
    const db = new SqliteAdapter(':memory:');
    await db.exec(SCHEMA);
    const audit = new AuditLog(db);
    const writeStart = performance.now();
    for (let i = 0; i < n; i += 1) await audit.append({ id: 'bench', role: 'admin' }, 'bench', 'thing', `T${i}`, { i });
    const writeMs = performance.now() - writeStart;
    const verifyStart = performance.now();
    const verdict = await audit.verify();
    results.audit.push({ entries: n, appendMsEach: +(writeMs / n).toFixed(3), verifyMs: +(performance.now() - verifyStart).toFixed(1), valid: verdict.valid });
    db.close();
  }

  fs.writeFileSync(path.join(RESULTS, 'algorithm-benchmark.json'), JSON.stringify(results, null, 2));
  const md = [
    '# Algorithm benchmark', '', `Date: ${results.date}  `, `Machine: ${results.machine}`, '',
    '## Fingerprint matching (60-value clip vs. catalogue of 240-value fingerprints)', '',
    '| Recordings | First search (ms) | With cache (ms) | Correct song found | Confidence |', '|---|---|---|---|---|',
    ...results.fingerprint.map((r) => `| ${r.recordings} | ${r.coldMs} | ${r.warmMs} | ${r.matched ? 'yes' : 'NO'} | ${r.confidence} |`), '',
    '## Matching accuracy (600 clips vs. 1,000 registered songs)', '',
    `Precision ${(results.accuracy.precision * 100).toFixed(1)}% · recall ${(results.accuracy.recall * 100).toFixed(1)}% · `
      + `${results.accuracy.truePositives} correct, ${results.accuracy.falsePositives} wrong matches, ${results.accuracy.falseNegatives} missed, ${results.accuracy.trueNegatives} strangers correctly rejected. `
      + 'Note: synthetic fingerprints with random bit noise; real broadcast audio must be re-measured in the pilot.', '',
    '## Largest-remainder allocation of Rwf 987,654,321', '',
    '| Shares | Time (ms) | Adds up exactly |', '|---|---|---|',
    ...results.allocation.map((r) => `| ${r.shares.toLocaleString('en-US')} | ${r.ms} | ${r.exact ? 'yes' : 'NO'} |`), '',
    '## Monthly royalty calculation (500 songs, 2 writers each, 10% unconfirmed)', '',
    '| Plays | Royalty lines | Time (ms) | Fee + paid + held = pool |', '|---|---|---|---|',
    ...results.royalties.map((r) => `| ${r.plays.toLocaleString('en-US')} | ${r.lines.toLocaleString('en-US')} | ${r.ms} | ${r.balanced ? 'yes' : 'NO'} |`), '',
    '## Audit hash chain', '',
    '| Entries | Append (ms each) | Verify whole chain (ms) | Valid |', '|---|---|---|---|',
    ...results.audit.map((r) => `| ${r.entries.toLocaleString('en-US')} | ${r.appendMsEach} | ${r.verifyMs} | ${r.valid ? 'yes' : 'NO'} |`)
  ].join('\n');
  fs.writeFileSync(path.join(RESULTS, 'algorithm-benchmark.md'), `${md}\n`);
  console.log(md);
}

main().catch((error) => { console.error(error); process.exit(1); });
