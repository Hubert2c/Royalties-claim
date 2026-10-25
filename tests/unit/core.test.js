// =============================================================================
// tests/unit/core.test.js — unit tests for the core algorithms (no server needed)
// Run with: npm test
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');

// Use a throw-away database so requiring the modules never touches real data.
process.env.DB_PATH = path.join(os.tmpdir(), `royalty-hub-unit-${process.pid}.db`);
process.env.SKIP_SEED = 'true';

const { MoneyAllocator } = require('../../lib/money/MoneyAllocator');
const { RoyaltyEngine } = require('../../lib/royalties/RoyaltyEngine');
const { FingerprintMatcher } = require('../../lib/fingerprint/FingerprintMatcher');
const { DemoFingerprints } = require('../../lib/fingerprint/DemoFingerprints');
const { TariffRule, TariffRuleFactory } = require('../../lib/tariffs/TariffRules');
const { CsvUsageParser } = require('../../lib/usage/ReportParsers');
const { FieldEncryptor } = require('../../lib/security/FieldEncryptor');
const STORAGE_KEYS = require('../../shared/storage-keys');

const allocate = MoneyAllocator.allocate;
const engine = new RoyaltyEngine();
const matcher = new FingerprintMatcher();

test('allocate() splits money into whole francs that add up exactly', () => {
  assert.deepEqual(allocate(100, [1, 1, 1]), [34, 33, 33]);
  assert.deepEqual(allocate(1000, [60, 40]), [600, 400]);
  const parts = allocate(1020000, Array(11).fill(1));
  assert.equal(parts.reduce((a, b) => a + b, 0), 1020000);
  assert.ok(Math.max(...parts) - Math.min(...parts) <= 1, 'equal shares differ by at most 1 franc');
  assert.deepEqual(allocate(0, [1, 2]), [0, 0]);
});

test('splits are complete only when all confirmed and totalling 100%', () => {
  assert.equal(RoyaltyEngine.splitsAreComplete([{ status: 'confirmed', share_percent: 60 }, { status: 'confirmed', share_percent: 40 }]), true);
  assert.equal(RoyaltyEngine.splitsAreComplete([{ status: 'confirmed', share_percent: 60 }, { status: 'pending', share_percent: 40 }]), false);
  assert.equal(RoyaltyEngine.splitsAreComplete([{ status: 'confirmed', share_percent: 90 }]), false);
  assert.equal(RoyaltyEngine.splitsAreComplete([]), false);
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
  const result = engine.calculate(inputs, 0.15);
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
  const result = engine.calculate({ pool: 100000, usage: [], splitsByWork: {} }, 0.9);
  assert.equal(result.adminFeeRate, RoyaltyEngine.MAX_ADMIN_FEE_RATE);
  assert.equal(result.adminFee, 30000);
  assert.equal(result.held, 70000, 'with no usage, the whole distributable amount is held');
});

test('fingerprint matching finds a noisy clip of a registered song and rejects strangers', () => {
  const songA = DemoFingerprints.synthetic(1, 240);
  const songB = DemoFingerprints.synthetic(2, 240);
  const catalogue = [{ id: 'A', fingerprint: songA.join(',') }, { id: 'B', fingerprint: songB.join(',') }];

  const clip = DemoFingerprints.noisySample(songB, 100, 60, 4); // 60 frames from the middle of B, with radio noise
  const hit = matcher.identify(clip, catalogue);
  assert.equal(hit.matched, true);
  assert.equal(hit.recording.id, 'B');
  assert.ok(hit.confidence > 0.8);

  const stranger = DemoFingerprints.synthetic(999, 60);
  const miss = matcher.identify(stranger, catalogue);
  assert.equal(miss.matched, false);
  assert.ok(miss.confidence < matcher.threshold);
  assert.equal(FingerprintMatcher.popcount32(0xffffffff), 32);
});

test('tariff fees: annual pro-rata, % of gross, per advert', () => {
  assert.equal(TariffRule.monthsCovered('2026-01-01', '2026-12-31'), 12);
  assert.equal(TariffRuleFactory.computeFee({ basis: 'flat_annual', rate: 1200000 }, { periodStart: '2026-01-01', periodEnd: '2026-12-31' }).fee, 1200000);
  assert.equal(TariffRuleFactory.computeFee({ basis: 'flat_annual', rate: 1200000 }, { periodStart: '2026-10-01', periodEnd: '2026-12-31' }).fee, 300000);
  assert.equal(TariffRuleFactory.computeFee({ basis: 'percent_gross', rate: 5 }, { grossAmount: 10000000 }).fee, 500000);
  assert.equal(TariffRuleFactory.computeFee({ basis: 'per_ad', rate: 50000 }, { quantity: 4 }).fee, 200000);
  assert.throws(() => TariffRuleFactory.computeFee({ basis: 'per_ad', rate: 50000 }, { quantity: 0 }));
});

test('CSV reader handles quotes and commas inside fields', () => {
  const rows = new CsvUsageParser().parse('played_at,title,artist\n2026-10-01,"Hello, World","Say ""hi"""\n');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'Hello, World');
  assert.equal(rows[0].artist, 'Say "hi"');
});

test('payout numbers are encrypted and can be decrypted', () => {
  const box = new FieldEncryptor('test-secret');
  const packed = box.encrypt('0788123456');
  assert.notEqual(packed, '0788123456');
  assert.equal(box.decrypt(packed), '0788123456');
  // A different key cannot read it (AES-GCM authentication fails).
  assert.throws(() => new FieldEncryptor('another-secret').decrypt(packed));
});

test('each portal uses separate browser storage keys', () => {
  const tokens = Object.values(STORAGE_KEYS).map((k) => k.token);
  assert.equal(new Set(tokens).size, tokens.length);
});
