// =============================================================================
// tests/performance/load-test.js — how fast is the API under load?
// -----------------------------------------------------------------------------
// Starts the real server on a throw-away database, then uses autocannon to
// send many requests at once to four typical endpoints, at three load levels
// (10, 50 and 100 users at the same time). While it runs, the server's CPU and
// memory are sampled with pidusage.
//
// Finally a STRESS test checks the protection against floods: with a low rate
// limit, extra requests must be refused with HTTP 429 instead of slowing the
// server down.
//
// Run with:  npm run test:load
// Results:   tests/performance/results/load-test.json and .md
// =============================================================================

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const autocannon = require('autocannon');
const pidusage = require('pidusage');

const ROOT = path.join(__dirname, '..', '..');
const RESULTS = path.join(__dirname, 'results');
const DURATION = Number(process.env.LOAD_SECONDS || 10);

/** Start server.js in its own process with its own database. */
function startServer(port, extraEnv = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'royalty-load-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), DB_PATH: path.join(tmp, 'load.db'), UPLOAD_DIR: path.join(tmp, 'up'), NODE_ENV: 'test', DASHBOARD_CACHE_MS: '3000', ...extraEnv },
    stdio: 'ignore'
  });
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (res.ok) return resolve({ child, startupMs: Date.now() - started });
      } catch (e) { /* not up yet */ }
      if (Date.now() - started > 30000) return reject(new Error('server did not start'));
      return setTimeout(poll, 150);
    };
    poll();
  });
}

async function api(base, method, url, body, headers = {}) {
  const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  return res.json();
}

/** Run one autocannon scenario while sampling the server's CPU and memory. */
async function run(pid, scenario) {
  const samples = [];
  const timer = setInterval(async () => {
    try { samples.push(await pidusage(pid)); } catch (e) { /* ignore */ }
  }, 250);
  const result = await autocannon({ duration: DURATION, ...scenario.options });
  clearInterval(timer);
  const cpu = samples.map((s) => s.cpu);
  const mem = samples.map((s) => s.memory / 1048576);
  return {
    endpoint: scenario.name,
    users: scenario.options.connections,
    requests: result.requests.total,
    reqPerSec: Math.round(result.requests.average),
    latencyP50: result.latency.p50,
    latencyP97_5: result.latency.p97_5,
    latencyP99: result.latency.p99,
    errors: result.errors + result.timeouts + (result.non2xx || 0),
    cpuAvg: cpu.length ? Math.round(cpu.reduce((a, b) => a + b, 0) / cpu.length) : null,
    memMaxMB: mem.length ? Math.round(Math.max(...mem)) : null
  };
}

async function main() {
  fs.mkdirSync(RESULTS, { recursive: true });
  const port = 3601;
  const base = `http://127.0.0.1:${port}`;
  const { child, startupMs } = await startServer(port, { RATE_LIMIT_MAX: '100000000' });

  // Prepare a login token and an API key, like real clients would.
  const { token } = await api(base, 'POST', '/api/auth/login', { email: 'admin@royaltyhub.com', password: 'admin123' });
  const radio = await api(base, 'POST', '/api/auth/login', { email: 'radio@royaltyhub.com', password: 'licensee123' });
  const { key } = await api(base, 'POST', '/api/licensee/api-keys', { label: 'load test' }, { Authorization: `Bearer ${radio.token}` });
  const catalogue = await api(base, 'GET', '/api/open/v1/catalogue', null, { 'X-API-Key': key });

  // A 60-value fingerprint (about 7 seconds of audio) for the matching endpoint.
  const { DemoFingerprints } = require('../../lib/fingerprint/DemoFingerprints');
  const clip = DemoFingerprints.noisySample(DemoFingerprints.synthetic(101, 240), 50, 60, 4);

  const scenarios = (connections) => [
    { name: 'GET /api/public/summary (public dashboard)', options: { url: `${base}/api/public/summary`, connections } },
    { name: 'GET /api/admin/overview (login + 12 queries)', options: { url: `${base}/api/admin/overview`, connections, headers: { Authorization: `Bearer ${token}` } } },
    { name: 'POST /api/open/v1/fingerprint-matches (matching)', options: { url: `${base}/api/open/v1/fingerprint-matches`, method: 'POST', connections, headers: { 'Content-Type': 'application/json', 'X-API-Key': key }, body: JSON.stringify({ fingerprint: clip }) } },
    { name: 'POST /api/open/v1/usage (10-play report)', options: { url: `${base}/api/open/v1/usage`, method: 'POST', connections, headers: { 'Content-Type': 'application/json', 'X-API-Key': key }, body: JSON.stringify({ source: 'play_log', events: Array.from({ length: 10 }, () => ({ title: catalogue.recordings[0].title, played_at: new Date().toISOString() })) }) } }
  ];

  // --- Phase 1: the demo database ------------------------------------------------------
  const rows = [];
  for (const users of [10, 50, 100]) {
    for (const scenario of scenarios(users)) {
      process.stdout.write(`${scenario.name} with ${users} users... `);
      const row = await run(child.pid, scenario);
      rows.push(row);
      console.log(`${row.reqPerSec} req/s, p50 ${row.latencyP50} ms, p99 ${row.latencyP99} ms, errors ${row.errors}`);
    }
  }

  // --- Phase 2: a big database -----------------------------------------------------------
  // Add 100,000 plays (1,000 per request), then measure the dashboards again.
  // This checks that the indexes keep reads fast when the data grows.
  const bulkStart = Date.now();
  for (let batch = 0; batch < 100; batch += 1) {
    await api(base, 'POST', '/api/open/v1/usage', {
      source: 'play_log',
      events: Array.from({ length: 1000 }, (_, i) => (i % 4 === 0
        ? { title: `Unknown song ${batch}-${i}`, played_at: new Date().toISOString() }
        : { title: catalogue.recordings[i % catalogue.recordings.length].title, played_at: new Date().toISOString() }))
    }, { 'X-API-Key': key });
  }
  const bulkSeconds = (Date.now() - bulkStart) / 1000;
  console.log(`Inserted 100,000 plays in ${bulkSeconds.toFixed(1)} s`);
  const bigRows = [];
  for (const scenario of scenarios(50).slice(0, 2)) {
    process.stdout.write(`[big database] ${scenario.name} with 50 users... `);
    const row = await run(child.pid, scenario);
    bigRows.push(row);
    console.log(`${row.reqPerSec} req/s, p50 ${row.latencyP50} ms, p99 ${row.latencyP99} ms`);
  }
  child.kill();

  // --- Stress: does the rate limit protect the server? -------------------------------
  const limited = await startServer(port + 1, { RATE_LIMIT_MAX: '200' });
  const flood = await autocannon({ url: `http://127.0.0.1:${port + 1}/api/public/summary`, connections: 50, amount: 1000 });
  limited.child.kill();
  const stress = { sent: 1000, accepted: flood['2xx'], refused429: flood.non2xx, limit: 200 };
  console.log('Stress test:', stress);

  const machine = { cpu: os.cpus()[0].model, cores: os.cpus().length, ramGB: Math.round(os.totalmem() / 1073741824), os: `${os.type()} ${os.release()}`, node: process.version };
  const report = { date: new Date().toISOString(), machine, durationPerScenarioSec: DURATION, startupMs, rows, bulk: { plays: 100000, seconds: bulkSeconds }, bigRows, stress };
  fs.writeFileSync(path.join(RESULTS, 'load-test.json'), JSON.stringify(report, null, 2));

  const md = [
    '# Load test results',
    '',
    `Date: ${report.date}  `,
    `Machine: ${machine.cpu}, ${machine.cores} cores, ${machine.ramGB} GB RAM, ${machine.os}, Node ${machine.node}  `,
    `Each scenario ran for ${DURATION} s. Server start-up (including demo data): ${startupMs} ms.`,
    '',
    '| Endpoint | Users | Req/s | p50 ms | p97.5 ms | p99 ms | Errors | CPU % | RAM MB |',
    '|---|---|---|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.endpoint} | ${r.users} | ${r.reqPerSec} | ${r.latencyP50} | ${r.latencyP97_5} | ${r.latencyP99} | ${r.errors} | ${r.cpuAvg} | ${r.memMaxMB} |`),
    '',
    `Big database: 100,000 extra plays inserted through the Open API in ${bulkSeconds.toFixed(1)} s (${Math.round(100000 / bulkSeconds)} plays/s). Then, with 50 users:`,
    '',
    '| Endpoint | Users | Req/s | p50 ms | p97.5 ms | p99 ms | Errors | CPU % | RAM MB |',
    '|---|---|---|---|---|---|---|---|---|',
    ...bigRows.map((r) => `| ${r.endpoint} | ${r.users} | ${r.reqPerSec} | ${r.latencyP50} | ${r.latencyP97_5} | ${r.latencyP99} | ${r.errors} | ${r.cpuAvg} | ${r.memMaxMB} |`),
    '',
    `Stress test: ${stress.sent} requests from 50 users against a limit of ${stress.limit}: ${stress.accepted} accepted, ${stress.refused429} refused with HTTP 429.`
  ].join('\n');
  fs.writeFileSync(path.join(RESULTS, 'load-test.md'), `${md}\n`);
  console.log(`\nSaved ${path.relative(ROOT, path.join(RESULTS, 'load-test.md'))}`);
}

main().catch((error) => { console.error(error); process.exit(1); });
