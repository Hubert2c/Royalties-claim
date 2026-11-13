// =============================================================================
// tests/integration/api.test.js — end-to-end API tests against a real server and a
// throw-away SQLite database. Follows the full flow from the document:
// licence → payment → usage → distribution run → approval → payout → statement.
// Run with: npm test
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'royalty-hub-api-'));
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret';
process.env.PORT = '3456';
process.env.DB_PATH = path.join(tmp, 'test.db');
process.env.UPLOAD_DIR = path.join(tmp, 'uploads');

const { server, ready } = require('../../server');
const { db } = require('../../database');
const BASE = 'http://127.0.0.1:3456';

test.after(() => server.close());

// Small helper: call the API and return { status, body }.
async function call(method, url, { token, body, apiKey } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (apiKey) headers['X-API-Key'] = apiKey;
  const res = await fetch(`${BASE}${url}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = {};
  try { json = await res.json(); } catch (e) { /* not JSON */ }
  return { status: res.status, body: json };
}

async function login(email, password) {
  const res = await call('POST', '/api/auth/login', { body: { email, password } });
  assert.equal(res.status, 200, `login failed for ${email}`);
  return res.body.token;
}

const period = new Date().toISOString().slice(0, 7);

test('health check and private files are not served', async () => {
  await ready;
  assert.equal((await call('GET', '/api/health')).body.service, 'royalty-hub-api');
  for (const privatePath of ['/.env', '/database.js', '/data/royalty_hub.db', '/package.json']) {
    const res = await fetch(`${BASE}${privatePath}`);
    const text = await res.text();
    assert.ok(!text.includes('JWT_SECRET') && !text.includes('require('), `${privatePath} must not be served`);
  }
});

test('registration validates input and never creates admins', async () => {
  assert.equal((await call('POST', '/api/auth/register', { body: { name: 'X', email: 'bad', password: 'password123', role: 'rightsholder', holderType: 'writer' } })).status, 400);
  assert.equal((await call('POST', '/api/auth/register', { body: { name: 'X', email: 'x@test.rw', password: 'password123', role: 'admin' } })).status, 400);
  const ok = await call('POST', '/api/auth/register', { body: { name: 'New Writer', email: 'new@test.rw', password: 'password123', role: 'rightsholder', holderType: 'writer', payoutRef: '0788000000' } });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.user.role, 'rightsholder');
});

test('roles are enforced (artists cannot use the government console; auditors cannot write)', async () => {
  const artist = await login('artist@royaltyhub.com', 'artist123');
  assert.equal((await call('GET', '/api/admin/overview', { token: artist })).status, 403);
  assert.equal((await call('POST', '/api/auth/login', { body: { email: 'artist@royaltyhub.com', password: 'artist123', portal: 'government' } })).status, 403);

  const auditor = await login('auditor@royaltyhub.com', 'auditor123');
  assert.equal((await call('GET', '/api/admin/overview', { token: auditor })).status, 200);
  assert.equal((await call('POST', '/api/admin/runs', { token: auditor, body: { period } })).status, 403);
});

test('splits must total exactly 100%', async () => {
  const artist = await login('artist@royaltyhub.com', 'artist123');
  const bad = await call('POST', '/api/rightsholder/works', {
    token: artist,
    body: { title: 'Bad Split', recording: {}, splits: [{ holder_id: 'RH-HUBERT', share_percent: 60, right_type: 'lyrics' }, { holder_id: 'RH-ALINE', share_percent: 30, right_type: 'music' }] }
  });
  assert.equal(bad.status, 400);
  assert.match(bad.body.message, /100%/);
});

test('full flow: licence → payment → usage → run → approval → payout → statement', async () => {
  const admin = await login('admin@royaltyhub.com', 'admin123');
  const venue = await login('venue@royaltyhub.com', 'licensee123');
  const artist = await login('artist@royaltyhub.com', 'artist123');

  // The hotel's seeded licence is invoiced; it pays (simulated).
  const pay = await call('POST', '/api/licensee/licences/LCN-VENUE/pay', { token: venue, body: { channel: 'momo', payer: '0788123456' } });
  assert.equal(pay.status, 200, pay.body.message);

  // The hotel reports two songs: one matches by ISRC, one is unknown.
  const usage = await call('POST', '/api/licensee/usage', {
    token: venue,
    body: { source: 'play_log', rows: [
      { played_at: new Date().toISOString(), title: 'x', isrc: 'RWA012600002' },
      { played_at: new Date().toISOString(), title: 'Totally Unknown Song', artist: 'Nobody' }
    ] }
  });
  assert.equal(usage.status, 201);
  assert.equal(usage.body.summary.matched, 1);
  assert.equal(usage.body.summary.unmatched, 1);

  // Draft run, approve, pay.
  const created = await call('POST', '/api/admin/runs', { token: admin, body: { period } });
  assert.equal(created.status, 201, created.body.message);
  const run = created.body.run;
  assert.equal(run.total_pool, 1200000 + 150000);
  assert.equal(run.admin_fee + run.distributable, run.total_pool);

  // A second run for the same period is refused.
  assert.equal((await call('POST', '/api/admin/runs', { token: admin, body: { period } })).status, 409);

  // Every franc of the distributable money is either in a payable line or held.
  const lineSum = Number((await db.prepare('SELECT COALESCE(SUM(amount), 0) AS s FROM royalty_lines WHERE run_id = ?').get(run.id)).s);
  assert.equal(lineSum, run.distributable);

  assert.equal((await call('POST', `/api/admin/runs/${run.id}/approve`, { token: admin })).status, 200);
  assert.equal((await call('POST', `/api/admin/runs/${run.id}/pay`, { token: admin })).status, 200);

  const statement = await call('GET', '/api/rightsholder/statements', { token: artist });
  assert.equal(statement.status, 200);
  assert.ok(statement.body.lines.length > 0);
  assert.ok(statement.body.lines.every((l) => l.paid_status === 'paid' && l.licensee_name && l.played_at));
  assert.ok(statement.body.totals.heldForMyWorks > 0, 'City Lights has an unconfirmed split, so its money is held');

  // Public dashboard publishes the run.
  const pub = await call('GET', '/api/public/summary');
  assert.equal(pub.body.runs[0].period, period);
});

test('open API: licensee key reports usage; bad keys are refused', async () => {
  const radio = await login('radio@royaltyhub.com', 'licensee123');
  const created = await call('POST', '/api/licensee/api-keys', { token: radio, body: { label: 'test' } });
  assert.equal(created.status, 201);
  const key = created.body.key;

  assert.equal((await call('POST', '/api/open/v1/usage', { apiKey: 'rh_live_wrong', body: { events: [] } })).status, 401);
  const ok = await call('POST', '/api/open/v1/usage', { apiKey: key, body: { source: 'play_log', events: [{ title: 'Midnight Echo', artist: 'Munezero Hubert', played_at: new Date().toISOString() }] } });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.matched, 1);
});

test('live monitor: back-to-back clips of the same song become ONE play', async () => {
  const { DemoFingerprints } = require('../../lib/fingerprint/DemoFingerprints');
  const { FingerprintMatcher } = require('../../lib/fingerprint/FingerprintMatcher');
  const radio = await login('radio@royaltyhub.com', 'licensee123');
  const key = (await call('POST', '/api/licensee/api-keys', { token: radio, body: { label: 'live monitor' } })).body.key;

  // Two registered songs with fingerprints, taken from the demo catalogue.
  const songs = await db.prepare('SELECT id, title, fingerprint FROM recordings WHERE fingerprint IS NOT NULL ORDER BY id LIMIT 2').all();
  const clip = (song, start) => DemoFingerprints.noisySample(FingerprintMatcher.parse(song.fingerprint), start, 60, 4);
  const at = (seconds) => new Date(Date.UTC(2030, 0, 1, 12, 0, seconds)).toISOString(); // a fixed, future time
  const send = (song, start, seconds) => call('POST', '/api/open/v1/fingerprint-matches',
    { apiKey: key, body: { played_at: at(seconds), duration_sec: 15, fingerprint: clip(song, start) } });

  // Clip 1 starts a new play; clips 2 and 3 (15 s apart) extend it.
  const first = await send(songs[0], 10, 0);
  assert.deepEqual([first.status, first.body.matched, first.body.merged], [201, true, false]);
  const second = await send(songs[0], 60, 15);
  const third = await send(songs[0], 110, 30);
  assert.deepEqual([second.body.merged, third.body.merged], [true, true]);
  assert.equal(third.body.usage_id, first.body.usage_id, 'same play, not a new one');
  assert.equal(third.body.duration_sec, 45, 'the play now lasts from 12:00:00 to 12:00:45');

  // A different song straight after is a NEW play.
  const other = await send(songs[1], 10, 45);
  assert.deepEqual([other.status, other.body.merged, other.body.title], [201, false, songs[1].title]);

  // The first song again after a long break (5 minutes) is also a NEW play.
  const later = await send(songs[0], 10, 400);
  assert.equal(later.body.merged, false);
  assert.notEqual(later.body.usage_id, first.body.usage_id);

  // Unidentified clips are never merged, so each unregistered song stays claimable.
  const noise = () => Array.from({ length: 60 }, (_, i) => (i * 2654435761) >>> 0);
  const u1 = await call('POST', '/api/open/v1/fingerprint-matches', { apiKey: key, body: { played_at: at(600), duration_sec: 15, fingerprint: noise() } });
  const u2 = await call('POST', '/api/open/v1/fingerprint-matches', { apiKey: key, body: { played_at: at(615), duration_sec: 15, fingerprint: noise() } });
  assert.deepEqual([u1.body.matched, u2.body.merged], [false, false]);
  assert.notEqual(u1.body.usage_id, u2.body.usage_id);

  // record_unmatched: false (stream monitoring) -> unknown audio is not saved, known songs still are.
  const before = (await db.prepare('SELECT COUNT(*) AS n FROM usage_events').get()).n;
  const skipped = await call('POST', '/api/open/v1/fingerprint-matches', { apiKey: key, body: { played_at: at(900), duration_sec: 15, fingerprint: noise(), record_unmatched: false } });
  assert.deepEqual([skipped.status, skipped.body.saved, skipped.body.usage_id], [200, false, null]);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM usage_events').get()).n, before, 'nothing saved');
  const known = await send(songs[1], 20, 1000);
  assert.equal(known.body.matched, true);
});

test('unclaimed plays can be claimed, and disputes can be raised and resolved', async () => {
  const radio = await login('radio@royaltyhub.com', 'licensee123');
  const artist = await login('artist@royaltyhub.com', 'artist123');
  const admin = await login('admin@royaltyhub.com', 'admin123');
  const key = (await call('POST', '/api/licensee/api-keys', { token: radio, body: { label: 'claims test' } })).body.key;

  // A station reports a song that is not in the registry: it becomes an unmatched play.
  const report = await call('POST', '/api/open/v1/usage', { apiKey: key, body: { source: 'play_log', events: [{ title: 'Song Nobody Registered', artist: 'Unknown', played_at: new Date().toISOString() }] } });
  const usageId = report.body.events[0].id;
  assert.equal(report.body.unmatched, 1);
  const unclaimed = await call('GET', '/api/public/unclaimed');
  assert.ok(unclaimed.body.usage.some((u) => u.id === usageId), 'the play is on the public unclaimed list');

  // The artist claims it for one of their own recordings; the administrator approves.
  const recordingId = (await call('GET', '/api/rightsholder/my-recordings', { token: artist })).body.recordings[0].id;
  const claim = await call('POST', '/api/rightsholder/claims', { token: artist, body: { usageId, recordingId, note: 'Logged under a working title.' } });
  assert.equal(claim.status, 201);
  const approved = await call('POST', `/api/admin/claims/${claim.body.claimId}/approve`, { token: admin });
  assert.equal(approved.status, 200);
  const usage = await db.prepare('SELECT status, recording_id FROM usage_events WHERE id = ?').get(usageId);
  assert.deepEqual([usage.status, usage.recording_id], ['matched', recordingId]);

  // Disputes: too-short reasons are refused; a real one is resolved by the administrator.
  assert.equal((await call('POST', '/api/disputes', { token: artist, body: { subjectType: 'statement', reason: 'bad' } })).status, 400);
  const dispute = await call('POST', '/api/disputes', { token: artist, body: { subjectType: 'statement', reason: 'My statement is missing two radio plays.' } });
  assert.equal(dispute.status, 201);
  const resolved = await call('POST', `/api/admin/disputes/${dispute.body.id}/resolve`, { token: admin, body: { status: 'resolved', resolution: 'Plays added to the next run.' } });
  assert.equal(resolved.status, 200);
  const mine = await call('GET', '/api/disputes', { token: artist });
  assert.equal(mine.body.disputes.find((d) => d.id === dispute.body.id).status, 'resolved');
});

test('audit log is hash-chained and detects tampering', async () => {
  const admin = await login('admin@royaltyhub.com', 'admin123');
  const good = await call('GET', '/api/admin/audit/verify', { token: admin });
  assert.equal(good.body.verification.valid, true);

  // Someone edits an old entry directly in the database...
  await db.prepare("UPDATE audit_log SET details = '{\"amount\":1}' WHERE seq = 2").run();
  const bad = await call('GET', '/api/admin/audit/verify', { token: admin });
  assert.equal(bad.body.verification.valid, false);
  assert.equal(bad.body.verification.brokenAt, 2);
});

test('new features: notifications, insights, trends, search, public monthly data', async () => {
  const admin = await login('admin@royaltyhub.com', 'admin123');
  const artist = await login('artist@royaltyhub.com', 'artist123');

  // The full-flow test approved and paid a run, so the artist was notified.
  const notes = await call('GET', '/api/notifications', { token: artist });
  assert.equal(notes.status, 200);
  assert.ok(notes.body.notifications.some((n) => /approved|sent to your/.test(n.title)));
  assert.equal((await call('POST', '/api/notifications/read-all', { token: artist })).status, 200);
  assert.equal((await call('GET', '/api/notifications', { token: artist })).body.unread, 0);

  const insights = await call('GET', '/api/rightsholder/insights', { token: artist });
  assert.equal(insights.body.months.length, 12);
  assert.ok(insights.body.earnings.some((v) => v > 0), 'demo history gives past earnings');
  assert.ok(insights.body.perPlayValue > 0);

  const trends = await call('GET', '/api/admin/trends', { token: admin });
  assert.equal(trends.body.collections.length, 12);
  const search = await call('GET', '/api/admin/search?q=RWA0126', { token: admin });
  assert.ok(search.body.results.some((r) => r.type === 'Recording'));
  assert.equal((await call('GET', '/api/admin/search?q=x', { token: artist })).status, 403);

  const pub = await call('GET', '/api/public/summary');
  assert.equal(pub.body.monthly.months.length, 12);
});
