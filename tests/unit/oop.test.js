// =============================================================================
// tests/unit/oop.test.js — unit tests for the class design and edge cases
// -----------------------------------------------------------------------------
// Checks that the object-oriented parts behave as designed:
//   * abstract base classes cannot be used directly
//   * factories return the right subclass (polymorphism)
//   * each subclass applies its own rules
//   * services work with injected collaborators (dependency injection)
// Plus edge cases of the algorithms (random "property" tests for the money split).
// Run with: npm test
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');

process.env.DB_PATH = path.join(os.tmpdir(), `royalty-hub-oop-${process.pid}.db`);
process.env.SKIP_SEED = 'true';

const errors = require('../../lib/errors');
const { MoneyAllocator } = require('../../lib/money/MoneyAllocator');
const {
  PaymentGateway, MobileMoneyGateway, BankTransferGateway, IremboGateway, PaymentGatewayFactory
} = require('../../lib/payments/gateways');
const {
  MatchStrategy, IsrcMatchStrategy, TitleArtistMatchStrategy, FingerprintMatchStrategy, UsageMatcher
} = require('../../lib/usage/MatchStrategies');
const { UsageReportParser, CsvUsageParser, JsonUsageParser } = require('../../lib/usage/ReportParsers');
const { TariffRule, FlatAnnualRule, PercentGrossRule, PerUnitRule, TariffRuleFactory } = require('../../lib/tariffs/TariffRules');
const { DatabaseAdapter, SqliteAdapter } = require('../../db/adapters');
const { SCHEMA } = require('../../db/schema');
const { AuditLog } = require('../../lib/audit/AuditLog');
const { UsageService } = require('../../lib/usage/UsageService');
const { DistributionService } = require('../../lib/royalties/DistributionService');
const { FingerprintMatcher } = require('../../lib/fingerprint/FingerprintMatcher');
const { DemoFingerprints } = require('../../lib/fingerprint/DemoFingerprints');

// A fresh in-memory database with the real schema, for service tests.
async function freshDb() {
  const db = new SqliteAdapter(':memory:');
  await db.exec(SCHEMA);
  return db;
}
let counter = 0;
const newId = (prefix) => `${prefix}-${String(++counter).padStart(6, '0')}`;
const nowIso = () => new Date().toISOString();

// --- Abstract classes ----------------------------------------------------------------

test('abstract base classes cannot be created directly', () => {
  assert.throws(() => new PaymentGateway('x'), TypeError);
  assert.throws(() => new MatchStrategy(), TypeError);
  assert.throws(() => new UsageReportParser(), TypeError);
  assert.throws(() => new TariffRule({ rate: 1 }), TypeError);
  assert.throws(() => new DatabaseAdapter('x'), TypeError);
});

// --- Error hierarchy -------------------------------------------------------------------

test('each error class carries its own HTTP status (inheritance)', () => {
  const cases = [
    [new errors.ValidationError('x'), 400], [new errors.AuthenticationError(), 401], [new errors.ForbiddenError(), 403],
    [new errors.NotFoundError('Run'), 404], [new errors.ConflictError('x'), 409], [new errors.NotConfiguredError('x'), 503]
  ];
  for (const [error, status] of cases) {
    assert.ok(error instanceof errors.AppError && error instanceof Error);
    assert.equal(error.status, status);
  }
  assert.equal(new errors.NotFoundError('Run').message, 'Run not found.');
});

test('the error handler answers AppErrors with their status and hides unknown errors', () => {
  const fakeRes = () => ({ code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
  const res1 = fakeRes();
  errors.errorHandler(new errors.ConflictError('Already paid.'), {}, res1, () => {});
  assert.deepEqual([res1.code, res1.body], [409, { message: 'Already paid.' }]);

  const res2 = fakeRes();
  const original = console.error;
  console.error = () => {}; // keep the test output clean
  errors.errorHandler(new Error('database password is wrong'), {}, res2, () => {});
  console.error = original;
  assert.equal(res2.code, 500);
  assert.equal(res2.body.message, 'Something went wrong on the server.', 'internal details are never sent to the browser');
});

// --- Payment gateways (polymorphism + factory) --------------------------------------

test('the gateway factory returns the right class for each channel', () => {
  assert.ok(PaymentGatewayFactory.create('momo') instanceof MobileMoneyGateway);
  assert.ok(PaymentGatewayFactory.create('bank') instanceof BankTransferGateway);
  assert.ok(PaymentGatewayFactory.create('irembo') instanceof IremboGateway);
  assert.ok(PaymentGatewayFactory.create('bitcoin') instanceof MobileMoneyGateway, 'unknown channels fall back to mobile money');
  for (const channel of ['momo', 'bank', 'irembo']) assert.ok(PaymentGatewayFactory.create(channel) instanceof PaymentGateway);
});

test('mobile money validates the payer number; bank does not need one', async () => {
  const momo = new MobileMoneyGateway();
  await assert.rejects(momo.collect({ amount: 1000, payer: '12345' }), errors.ValidationError);
  await assert.rejects(momo.collect({ amount: 1000, payer: '' }), errors.ValidationError);
  const ok = await momo.collect({ amount: 1000, payer: '0788 123 456' });
  assert.match(ok.reference, /^MOMO-SIM-[0-9A-F]{6}$/);
  assert.equal(ok.simulated, true);

  const bank = await new BankTransferGateway().collect({ amount: 1000 });
  assert.match(bank.reference, /^BANK-SIM-/);
  await assert.rejects(new BankTransferGateway().collect({ amount: 0 }), errors.ValidationError);
});

test('live mode refuses clearly until a provider is connected', async () => {
  const live = PaymentGatewayFactory.create('momo', { mode: 'live' });
  assert.equal(live.isSimulated, false);
  await assert.rejects(live.collect({ amount: 1000, payer: '0788123456' }), errors.NotConfiguredError);
  await assert.rejects(live.payout({ amount: 1000, runId: 'RUN-1' }), errors.NotConfiguredError);
});

// --- Usage matching strategies ---------------------------------------------------------

const catalogue = [
  { id: 'R1', title: 'Midnight Echo', performer: 'Munezero Hubert', isrc: 'RWA012600001', fingerprint: DemoFingerprints.synthetic(11, 120).join(',') },
  { id: 'R2', title: 'Golden Hours', performer: 'Aline Kay', isrc: 'RWA012600002', fingerprint: null }
];

test('each match strategy only handles rows it understands', () => {
  assert.equal(new IsrcMatchStrategy().canHandle({ title: 'x' }), false);
  assert.equal(new TitleArtistMatchStrategy().canHandle({ title: 'x' }), true);
  assert.equal(new FingerprintMatchStrategy().canHandle({ isrc: 'x' }), false);
});

test('the matcher tries fingerprint, then ISRC, then title + artist', () => {
  const matcher = new UsageMatcher();
  assert.equal(matcher.match({ isrc: ' rwa012600002 ' }, catalogue).recording.id, 'R2', 'ISRC is trimmed and case-insensitive');
  assert.equal(matcher.match({ title: 'MIDNIGHT ECHO', artist: 'munezero hubert' }, catalogue).method, 'title');
  assert.equal(matcher.match({ title: 'Midnight Echo', artist: 'Someone Else' }, catalogue), null, 'wrong artist = no match');
  assert.equal(matcher.match({ title: 'Unknown Song' }, catalogue), null);

  const clip = DemoFingerprints.noisySample(FingerprintMatcher.parse(catalogue[0].fingerprint), 10, 40, 3);
  const hit = matcher.match({ fingerprint: clip }, catalogue);
  assert.equal(hit.recording.id, 'R1');
  assert.equal(hit.method, 'fingerprint');
});

test('a fingerprint that matches nothing is NOT rescued by a title (exclusive strategy)', () => {
  const stranger = DemoFingerprints.synthetic(4242, 40);
  assert.equal(new UsageMatcher().match({ fingerprint: stranger, title: 'Midnight Echo' }, catalogue), null);
});

test('new strategies can be added without changing the matcher (open/closed)', () => {
  class AlwaysFirstSong extends MatchStrategy {
    get name() { return 'test'; }

    canHandle() { return true; }

    match(row, cat) { return { recording: cat[0], confidence: 0.5 }; }
  }
  const result = new UsageMatcher([new AlwaysFirstSong()]).match({}, catalogue);
  assert.equal(result.method, 'test');
});

// --- Report parsers ------------------------------------------------------------------------

test('CSV parser: header only, Excel byte-order mark, Windows line endings', () => {
  assert.throws(() => new CsvUsageParser().parse('played_at,title,artist,isrc,duration_sec\n'), errors.ValidationError);
  assert.throws(() => new CsvUsageParser().parse(''), /first line must be/);
  const rows = new CsvUsageParser().parse('﻿Played_At,Title\r\n2026-10-01, Inzozi \r\n');
  assert.deepEqual([rows[0].played_at, rows[0].title], ['2026-10-01', 'Inzozi']);
});

test('JSON parser rejects non-lists and more than 5,000 rows', () => {
  assert.throws(() => new JsonUsageParser().parse('not a list'), /must be a list/);
  assert.throws(() => new JsonUsageParser().parse([]), /No usage rows/);
  const tooMany = Array.from({ length: 5001 }, () => ({ title: 'x' }));
  assert.throws(() => new JsonUsageParser().parse(tooMany), /at most 5,000/);
});

// --- Tariff rules ------------------------------------------------------------------------------

test('the tariff factory picks one rule class per basis', () => {
  assert.ok(TariffRuleFactory.forTariff({ basis: 'flat_annual', rate: 1 }) instanceof FlatAnnualRule);
  assert.ok(TariffRuleFactory.forTariff({ basis: 'percent_gross', rate: 1 }) instanceof PercentGrossRule);
  assert.ok(TariffRuleFactory.forTariff({ basis: 'per_ad', rate: 1 }) instanceof PerUnitRule);
  assert.ok(TariffRuleFactory.forTariff({ basis: 'per_event', rate: 1 }) instanceof PerUnitRule);
  assert.throws(() => TariffRuleFactory.forTariff({ basis: 'per_minute', rate: 1 }), errors.ValidationError);
});

test('tariff edge cases: reversed dates, a period over a year, decimals and zero receipts', () => {
  const annual = { basis: 'flat_annual', rate: 1200000 };
  assert.throws(() => TariffRuleFactory.computeFee(annual, { periodStart: '2026-12-31', periodEnd: '2026-01-01' }), /not valid/);
  assert.equal(TariffRuleFactory.computeFee(annual, { periodStart: '2026-01-01', periodEnd: '2027-06-30' }).fee, 1200000, 'capped at one year');
  assert.throws(() => TariffRuleFactory.computeFee({ basis: 'per_event', rate: 1000 }, { quantity: 2.5 }), /whole number/);
  assert.throws(() => TariffRuleFactory.computeFee({ basis: 'percent_gross', rate: 5 }, { grossAmount: 0 }), /gross receipts/);
});

// --- Money allocation: property tests ----------------------------------------------------

test('allocation always adds up exactly and is fair to within 1 franc (500 random cases)', () => {
  let seed = 7;
  const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let run = 0; run < 500; run += 1) {
    const total = Math.floor(random() * 5000000);
    const weights = Array.from({ length: 1 + Math.floor(random() * 12) }, () => 1 + Math.floor(random() * 100));
    const parts = MoneyAllocator.allocate(total, weights);
    const sumWeights = weights.reduce((a, b) => a + b, 0);
    assert.equal(parts.reduce((a, b) => a + b, 0), total);
    parts.forEach((part, i) => {
      assert.ok(Number.isInteger(part) && part >= 0);
      assert.ok(Math.abs(part - (total * weights[i]) / sumWeights) < 1, 'never more than 1 franc from the exact share');
    });
  }
});

test('allocation edge cases: fewer francs than people, negative totals', () => {
  assert.deepEqual(MoneyAllocator.allocate(2, [1, 1, 1]), [1, 1, 0]);
  assert.deepEqual(MoneyAllocator.allocate(-50, [1, 1]), [0, 0]);
  assert.deepEqual(MoneyAllocator.allocate(10, []), []);
});

// --- Services with an in-memory database ----------------------------------------------------

test('the SQLite adapter implements the shared database interface', async () => {
  const db = await freshDb();
  assert.ok(db instanceof DatabaseAdapter);
  await db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('k', 'v');
  assert.equal((await db.prepare('SELECT value FROM settings WHERE key = ?').get('k')).value, 'v');
  assert.equal(await db.prepare('SELECT value FROM settings WHERE key = ?').get('missing'), null);
});

test('audit log: a valid chain verifies, a deleted entry is detected', async () => {
  const db = await freshDb();
  const audit = new AuditLog(db);
  for (let i = 0; i < 5; i += 1) await audit.append({ id: 'u1', role: 'admin' }, 'test', 'thing', `T${i}`, { i });
  assert.deepEqual(await audit.verify(), { valid: true, count: 5, brokenAt: null, reason: null });
  await db.prepare('DELETE FROM audit_log WHERE seq = 3').run();
  const result = await audit.verify();
  assert.equal(result.valid, false);
  assert.equal(result.brokenAt, 3);
});

test('usage service: saves matched and unmatched rows and reports bad rows', async () => {
  const db = await freshDb();
  await db.prepare("INSERT INTO works (id, title, status, created_at) VALUES ('W1', 'Midnight Echo', 'active', ?)").run(nowIso());
  await db.prepare("INSERT INTO recordings (id, work_id, title, performer, isrc, created_at) VALUES ('R1', 'W1', 'Midnight Echo', 'Munezero Hubert', 'RWA012600001', ?)").run(nowIso());
  const service = new UsageService({ db, newId, nowIso });

  const summary = await service.record({ licenseeId: null, source: 'play_log', rows: [
    { isrc: 'RWA012600001', played_at: '2026-10-01T10:00:00Z' },
    { title: 'Nobody Knows', played_at: '2026-10-01T11:00:00Z' },
    { title: 'Bad date', played_at: 'yesterday-ish' },
    { duration_sec: 30 }
  ] });
  assert.deepEqual([summary.saved, summary.matched, summary.unmatched, summary.errors.length], [2, 1, 1, 2]);
  await assert.rejects(service.record({ source: 'radio', rows: [{ title: 'x' }] }), /Unknown usage source/);
  assert.throws(() => UsageService.assertReportable('simulation'), errors.ValidationError);
});

test('distribution service: uses an injected payment gateway and refuses double payment', async () => {
  const db = await freshDb();
  const t = nowIso();
  await db.prepare("INSERT INTO rights_holders (id, full_name, holder_type, payout_method, payout_ref_last4, status, created_at) VALUES ('H1', 'A', 'writer', 'momo', '3456', 'active', ?)").run(t);
  await db.prepare("INSERT INTO works (id, title, status, created_at) VALUES ('W1', 'Song', 'active', ?)").run(t);
  await db.prepare("INSERT INTO recordings (id, work_id, title, created_at) VALUES ('R1', 'W1', 'Song', ?)").run(t);
  await db.prepare("INSERT INTO splits (id, work_id, holder_id, share_percent, right_type, status, created_at) VALUES ('S1', 'W1', 'H1', 100, 'music', 'confirmed', ?)").run(t);
  await db.prepare("INSERT INTO licensees (id, name, category, created_at) VALUES ('L1', 'Radio', 'radio', ?)").run(t);
  await db.prepare("INSERT INTO tariffs (id, usage_type, name, basis, rate, status, created_at) VALUES ('T1', 'radio', 'x', 'per_ad', 1, 'approved', ?)").run(t);
  await db.prepare("INSERT INTO licences (id, licensee_id, tariff_id, period_start, period_end, fee_due, status, created_at) VALUES ('LC1', 'L1', 'T1', '2026-10-01', '2026-10-31', 10000, 'paid', ?)").run(t);
  await db.prepare("INSERT INTO payments (id, licence_id, amount, channel, reference, paid_at) VALUES ('P1', 'LC1', 10000, 'momo', 'ref', '2026-10-05T00:00:00Z')").run();
  await db.prepare("INSERT INTO usage_events (id, recording_id, source, played_at, period, status, created_at) VALUES ('U1', 'R1', 'play_log', '2026-10-06T00:00:00Z', '2026-10', 'matched', ?)").run(t);

  // A fake gateway, injected through the constructor, records what it was asked to pay.
  const paid = [];
  const fakeGateways = {
    create: () => ({ displayName: 'Mobile money', payout: async ({ amount }) => { paid.push(amount); return { reference: 'FAKE-1', simulated: true }; } })
  };
  const service = new DistributionService({ db, newId, nowIso, gateways: fakeGateways });

  const run = await service.createDraftRun('2026-10', 0.1, { id: 'admin' });
  assert.deepEqual([run.total_pool, run.admin_fee, run.distributable], [10000, 1000, 9000]);
  await assert.rejects(service.createDraftRun('2026-10', 0.1, { id: 'admin' }), errors.ConflictError);
  await assert.rejects(service.payRun(run.id), /Only an approved run/);
  await service.approveRun(run.id, { id: 'admin' });
  const result = await service.payRun(run.id);
  assert.deepEqual(paid, [9000]);
  assert.equal(result.paidHolders, 1);
  assert.equal((await service.getRun(run.id)).status, 'paid');
  await assert.rejects(service.payRun(run.id), errors.ConflictError, 'a paid run cannot be paid twice');
});
