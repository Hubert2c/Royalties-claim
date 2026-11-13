const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret';
process.env.PORT = '3458';

const { app, server } = require('../server');

test.after(() => {
  server.close();
});

assert.ok(app, 'Server should expose the Express app for production config tests.');

async function request(path, options = {}) {
  const base = 'http://127.0.0.1:3458';
  return fetch(`${base}${path}`, options);
}

test('app exposes health endpoint', async () => {
  const res = await request('/api/health');
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.service, 'royalty-hub-api');
});

test('registration validates email format', async () => {
  const res = await request('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Test User',
      email: 'bad-email',
      password: 'password123'
    })
  });

  assert.equal(res.status, 400);
  const json = await res.json();
  assert.match(json.message, /valid email/i);
});
