// =============================================================================
// tests/unit.test.js — tests for the core logic (no server needed)
// Run with: npm test
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');

// Use a throw-away database so requiring the modules never touches real data.
process.env.DB_PATH = path.join(os.tmpdir(), `royalty-hub-unit-${process.pid}.db`);
process.env.SKIP_SEED = 'true';

const { allocate, calculate, splitsAreComplete, MAX_ADMIN_FEE_RATE } = require('../lib/royalty-engine');
const fp = require('../lib/fingerprint');
const { computeFee, monthsCovered } = require('../lib/tariffs');
const { parseCsv } = require('../lib/csv');
const { encrypt, decrypt } = require('../lib/crypto-box');
const STORAGE_KEYS = require('../shared/storage-keys');

test('allocate() splits money into whole francs that add up exactly', () => {
  assert.deepEqual(allocate(100, [1, 1, 1]), [34, 33, 33]);
  assert.deepEqual(allocate(1000, [60, 40]), [600, 400]);
  const parts = allocate(1020000, Array(11).fill(1));
  assert.equal(parts.reduce((a, b) => a + b, 0), 1020000);
  assert.ok(Math.max(...parts) - Math.min(...parts) <= 1, 'equal shares differ by at most 1 franc');
  assert.deepEqual(allocate(0, [1, 2]), [0, 0]);
});

test('splits are complete only when all confirmed and totalling 100%', () => {
  assert.equal(splitsAreComplete([{ status: 'confirmed', share_percent: 60 }, { status: 'confirmed', share_percent: 40 }]), true);
  assert.equal(splitsAreComplete([{ status: 'confirmed', share_percent: 60 }, { status: 'pending', share_percent: 40 }]), false);
  assert.equal(splitsAreComplete([{ status: 'confirmed', share_percent: 90 }]), false);
  assert.equal(splitsAreComplete([]), false);
});

test('royalty calculation: fee, equal value per play, splits, held money', () => {
  const inputs = {
    pool: 1000000,
    usage: [
      { id: 'U1', work_id: 'W1' }, { id: 'U2', work_id: 'W1' },
      { id: 'U3', work_id: 'W2' }, { id: 'U4', work_id: 'W3' }
    ],
    splitsByWork: {
      W1: [{ holder_id: 'A', share_percent: 60, status: 'confirmed' }, { holder_id: 'B', share_percent: 40, status: 'confirmed' }],
      W2: [{ holder_id: 'B', share_percent: 100, status: 'confirmed' }],
      W3: [{ holder_id: 'A', share_percent: 50, status: 'confirmed' }, { holder_id: 'B', share_percent: 50, status: 'pending' }]
    }
  };
  const result = calculate(inputs, 0.15);
  assert.equal(result.adminFee, 150000);
  assert.equal(result.distributable, 850000);
  // 4 plays → 212,500 each. W3's play is held because B has not confirmed.
  assert.equal(result.held, 212500);
  const paidToA = result.lines.filter((l) => l.holderId === 'A').reduce((s, l) => s + l.amount, 0);
  const paidToB = result.lines.filter((l) => l.holderId === 'B').reduce((s, l) => s + l.amount, 0);
  assert.equal(paidToA, 255000);           // 60% of 2 plays
  assert.equal(paidToB, 170000 + 212500);  // 40% of 2 plays + 100% of 1 play
  // Everything is accounted for: fee + paid + held = pool.
  assert.equal(result.adminFee + paidToA + paidToB + result.held, inputs.pool);
});

test('the administration fee can never exceed 30%', () => {
  const result = calculate({ pool: 100000, usage: [], splitsByWork: {} }, 0.9);
  assert.equal(result.adminFeeRate, MAX_ADMIN_FEE_RATE);
  assert.equal(result.adminFee, 30000);
  assert.equal(result.held, 70000, 'with no usage, the whole distributable amount is held');
});

test('fingerprint matching finds a noisy clip of a registered song and rejects strangers', () => {
  const songA = fp.syntheticFingerprint(1, 240);
  const songB = fp.syntheticFingerprint(2, 240);
  const catalogue = [{ id: 'A', fingerprint: songA.join(',') }, { id: 'B', fingerprint: songB.join(',') }];

  const clip = fp.noisySample(songB, 100, 60, 4); // 60 frames from the middle of B, with radio noise
  const hit = fp.identify(clip, catalogue);
  assert.equal(hit.matched, true);
  assert.equal(hit.recording.id, 'B');
  assert.ok(hit.confidence > 0.8);

  const stranger = fp.syntheticFingerprint(999, 60);
  const miss = fp.identify(stranger, catalogue);
  assert.equal(miss.matched, false);
  assert.ok(miss.confidence < fp.MATCH_THRESHOLD);
  assert.equal(fp.popcount32(0xffffffff), 32);
});

test('tariff fees: annual pro-rata, % of gross, per advert', () => {
  assert.equal(monthsCovered('2026-01-01', '2026-12-31'), 12);
  assert.equal(computeFee({ basis: 'flat_annual', rate: 1200000 }, { periodStart: '2026-01-01', periodEnd: '2026-12-31' }).fee, 1200000);
  assert.equal(computeFee({ basis: 'flat_annual', rate: 1200000 }, { periodStart: '2026-10-01', periodEnd: '2026-12-31' }).fee, 300000);
  assert.equal(computeFee({ basis: 'percent_gross', rate: 5 }, { grossAmount: 10000000 }).fee, 500000);
  assert.equal(computeFee({ basis: 'per_ad', rate: 50000 }, { quantity: 4 }).fee, 200000);
  assert.throws(() => computeFee({ basis: 'per_ad', rate: 50000 }, { quantity: 0 }));
});

test('CSV reader handles quotes and commas inside fields', () => {
  const rows = parseCsv('played_at,title,artist\n2026-10-01,"Hello, World","Say ""hi"""\n');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'Hello, World');
  assert.equal(rows[0].artist, 'Say "hi"');
});

test('payout numbers are encrypted and can be decrypted', () => {
  const packed = encrypt('0788123456');
  assert.notEqual(packed, '0788123456');
  assert.equal(decrypt(packed), '0788123456');
});

test('each portal uses separate browser storage keys', () => {
  const tokens = Object.values(STORAGE_KEYS).map((k) => k.token);
  assert.equal(new Set(tokens).size, tokens.length);
});
