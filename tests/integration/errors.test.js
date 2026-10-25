// =============================================================================
// tests/integration/errors.test.js — the API with WRONG or unusual inputs
// -----------------------------------------------------------------------------
// Black-box tests against a real server and a throw-away database. Each test
// sends a bad request and checks that the API answers with the right HTTP
// status and a helpful message — and that nothing was changed.
// Run with: npm test
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'royalty-hub-errors-'));
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret';
process.env.PORT = '3457';
process.env.DB_PATH = path.join(tmp, 'test.db');
process.env.UPLOAD_DIR = path.join(tmp, 'uploads');

const { server, ready } = require('../../server');
const { db } = require('../../database');
const BASE = 'http://127.0.0.1:3457';

test.after(() => server.close());

async function call(method, url, { token, body, apiKey, raw } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (apiKey) headers['X-API-Key'] = apiKey;
  const res = await fetch(`${BASE}${url}`, { method, headers, body: raw !== undefined ? raw : (body ? JSON.stringify(body) : undefined) });
  let json = {};
  try { json = await res.json(); } catch (e) { /* not JSON */ }
  return { status: res.status, body: json };
}

async function login(email, password) {
  const res = await call('POST', '/api/auth/login', { body: { email, password } });
  assert.equal(res.status, 200, `login failed for ${email}`);
  return res.body.token;
}

const count = async (table) => Number((await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).n);

test('logins: wrong password, unknown user, missing fields, broken token', async () => {
  await ready;
  assert.equal((await call('POST', '/api/auth/login', { body: { email: 'admin@royaltyhub.com', password: 'wrong' } })).status, 401);
  assert.equal((await call('POST', '/api/auth/login', { body: { email: 'nobody@royaltyhub.com', password: 'x' } })).status, 401);
  assert.equal((await call('POST', '/api/auth/login', { body: {} })).status, 400);
  assert.equal((await call('GET', '/api/admin/overview')).status, 401, 'no token');
  assert.equal((await call('GET', '/api/admin/overview', { token: 'not.a.token' })).status, 401, 'forged token');
});

test('roles: music users and artists cannot reach the government API', async () => {
  const radio = await login('radio@royaltyhub.com', 'licensee123');
  const artist = await login('artist@royaltyhub.com', 'artist123');
  assert.equal((await call('GET', '/api/admin/licences', { token: radio })).status, 403);
  assert.equal((await call('POST', '/api/admin/runs', { token: artist, body: { period: '2026-10' } })).status, 403);
  assert.equal((await call('GET', '/api/rightsholder/works', { token: radio })).status, 403);
});

test('browsers may call their own server from any address, but other websites are blocked', async () => {
  const send = (origin) => fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ email: 'admin@royaltyhub.com', password: 'admin123' }) });
  assert.equal((await send('http://127.0.0.1:3457')).status, 200, 'same origin (e.g. a phone using the laptop IP)');
  assert.equal((await send('http://localhost:3001')).status, 200, 'another local portal');
  assert.equal((await send('https://evil.example')).status, 403, 'a foreign website');
});

test('malformed JSON and unknown endpoints get clear answers', async () => {
  const res = await call('POST', '/api/auth/login', { raw: '{"email": ' });
  assert.equal(res.status, 400);
  assert.match(res.body.message, /not valid JSON/);
  assert.equal((await call('GET', '/api/does-not-exist')).status, 404);
});

test('splits: totals other than 100%, a negative share, an unknown co-writer', async () => {
  const artist = await login('artist@royaltyhub.com', 'artist123');
  const before = await count('works');
  const send = (splits) => call('POST', '/api/rightsholder/works', { token: artist, body: { title: 'Test', recording: {}, splits } });
  assert.equal((await send([{ holder_id: 'RH-HUBERT', share_percent: 110, right_type: 'lyrics' }])).status, 400);
  assert.equal((await send([{ holder_id: 'RH-HUBERT', share_percent: 120, right_type: 'lyrics' }, { holder_id: 'RH-ALINE', share_percent: -20, right_type: 'music' }])).status, 400);
  assert.equal((await send([{ holder_id: 'RH-HUBERT', share_percent: 50, right_type: 'lyrics' }, { holder_id: 'RH-GHOST', share_percent: 50, right_type: 'music' }])).status, 400);
  assert.equal(await count('works'), before, 'no work was created');
});

test('licences: bad tariff, reversed dates, zero adverts', async () => {
  const radio = await login('radio@royaltyhub.com', 'licensee123');
  const apply = (body) => call('POST', '/api/licensee/licences', { token: radio, body });
  assert.equal((await apply({ tariffId: 'TRF-NOPE', periodStart: '2026-11-01', periodEnd: '2026-11-30', quantity: 1 })).status, 400);
  assert.equal((await apply({ tariffId: 'TRF-AD', periodStart: '2026-11-30', periodEnd: '2026-11-01', quantity: 1 })).status, 400);
  const zero = await apply({ tariffId: 'TRF-AD', periodStart: '2026-11-01', periodEnd: '2026-11-30', quantity: 0 });
  assert.equal(zero.status, 400);
  assert.match(zero.body.message, /at least 1/);
});

test('payments: a wrong mobile money number, paying twice, paying someone else\'s licence', async () => {
  const venue = await login('venue@royaltyhub.com', 'licensee123');
  const radio = await login('radio@royaltyhub.com', 'licensee123');
  const before = await count('payments');
  const badNumber = await call('POST', '/api/licensee/licences/LCN-VENUE/pay', { token: venue, body: { channel: 'momo', payer: '12345' } });
  assert.equal(badNumber.status, 400);
  assert.match(badNumber.body.message, /mobile money number/);
  assert.equal((await call('POST', '/api/licensee/licences/LCN-VENUE/pay', { token: radio, body: { channel: 'bank' } })).status, 404, 'not your licence');
  assert.equal(await count('payments'), before, 'no payment was recorded');

  assert.equal((await call('POST', '/api/licensee/licences/LCN-VENUE/pay', { token: venue, body: { channel: 'bank' } })).status, 200);
  assert.equal((await call('POST', '/api/licensee/licences/LCN-VENUE/pay', { token: venue, body: { channel: 'bank' } })).status, 409, 'already paid');
});

test('usage reports: empty CSV, wrong source, bad rows are reported but good rows are kept', async () => {
  const radio = await login('radio@royaltyhub.com', 'licensee123');
  const form = new FormData();
  form.append('source', 'play_log');
  form.append('file', new Blob(['played_at,title,artist,isrc,duration_sec\n'], { type: 'text/csv' }), 'empty.csv');
  const empty = await fetch(`${BASE}/api/licensee/usage/csv`, { method: 'POST', headers: { Authorization: `Bearer ${radio}` }, body: form });
  assert.equal(empty.status, 400);
  assert.match((await empty.json()).message, /no data rows/);

  assert.equal((await call('POST', '/api/licensee/usage', { token: radio, body: { source: 'simulation', rows: [{ title: 'x' }] } })).status, 400);
  const mixed = await call('POST', '/api/licensee/usage', { token: radio, body: { source: 'play_log', rows: [
    { title: 'Midnight Echo', artist: 'Munezero Hubert', played_at: '2026-10-02T10:00:00Z' },
    { title: 'Bad', played_at: 'not-a-date' }
  ] } });
  assert.equal(mixed.status, 201);
  assert.deepEqual([mixed.body.summary.saved, mixed.body.summary.errors.length], [1, 1]);
});

test('distribution runs: bad period format, approving or paying in the wrong order', async () => {
  const admin = await login('admin@royaltyhub.com', 'admin123');
  assert.equal((await call('POST', '/api/admin/runs', { token: admin, body: { period: '2026-13' } })).status, 400);
  assert.equal((await call('POST', '/api/admin/runs/RUN-NOPE/approve', { token: admin })).status, 409);
  assert.equal((await call('POST', '/api/admin/runs/RUN-NOPE/pay', { token: admin })).status, 409);
  const fee = await call('PUT', '/api/admin/settings', { token: admin, body: { adminFeeRate: 0.9 } });
  assert.equal(fee.status, 400, 'the admin fee can never be set above 30%');
});

test('public site: unknown clearance codes and open API with bad keys or data', async () => {
  // A code check always answers (200) with valid: true/false, so permit offices get a clear yes or no.
  const fake = await call('GET', '/api/public/clearance/CLR-FAKE0000');
  assert.deepEqual([fake.status, fake.body.valid], [200, false]);
  const unpaid = await call('GET', '/api/public/clearance/clr-venue-demo');
  assert.equal(unpaid.body.valid, true, 'codes are not case-sensitive (the venue paid in an earlier test)');
  assert.equal((await call('POST', '/api/open/v1/usage', { body: { events: [] } })).status, 401, 'no key');
  assert.equal((await call('POST', '/api/open/v1/usage', { apiKey: 'rh_live_wrong', body: { events: [] } })).status, 401);

  const radio = await login('radio@royaltyhub.com', 'licensee123');
  const key = (await call('POST', '/api/licensee/api-keys', { token: radio, body: { label: 'test' } })).body.key;
  assert.equal((await call('POST', '/api/open/v1/usage', { apiKey: key, body: { events: 'oops' } })).status, 400);
  assert.equal((await call('POST', '/api/open/v1/fingerprint-matches', { apiKey: key, body: {} })).status, 400);
});
