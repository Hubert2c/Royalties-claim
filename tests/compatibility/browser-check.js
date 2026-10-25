// =============================================================================
// tests/compatibility/browser-check.js — devices, browsers and slow hardware
// -----------------------------------------------------------------------------
// 1. COMPATIBILITY: opens every portal on five screen profiles (desktop, laptop,
//    tablet, two phones) and checks: the page works (no JavaScript errors), the
//    main content is visible, and nothing sticks out sideways (no horizontal
//    scrolling). A screenshot of each is saved.
// 2. PERFORMANCE: loads the public dashboard and the console on three
//    simulated hardware/network profiles (Chrome DevTools throttling):
//      high-end  — no throttling
//      mid-range — CPU 4× slower, "Fast 3G" network
//      low-end   — CPU 6× slower, "Slow 3G" network
//    and records First Contentful Paint, load time, JS memory and data used.
//
// Needs Playwright:  npm i -D playwright && npx playwright install
// Run:               npm run test:browsers                      (Chromium)
//                    BROWSERS=chromium,firefox,webkit npm run test:browsers
// Results:           tests/compatibility/results/
// =============================================================================

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium, firefox, webkit, devices } = require('playwright');

const ROOT = path.join(__dirname, '..', '..');
const RESULTS = path.join(__dirname, 'results');
const ENGINES = { chromium, firefox, webkit };
const PORT = 3611;
const BASE = `http://127.0.0.1:${PORT}`;

const PROFILES = [
  { name: 'Desktop 1920×1080', options: { viewport: { width: 1920, height: 1080 } } },
  { name: 'Laptop 1366×768', options: { viewport: { width: 1366, height: 768 } } },
  { name: 'Tablet (iPad Mini)', options: devices['iPad Mini'] },
  { name: 'Phone (iPhone 13)', options: devices['iPhone 13'] },
  { name: 'Phone (Pixel 5)', options: devices['Pixel 5'] }
];

const PAGES = [
  { name: 'Government console', path: '/', login: ['admin@royaltyhub.com', 'admin123'], ready: '#view-overview' },
  { name: 'Rights-holder portal', path: '/artist/', login: ['artist@royaltyhub.com', 'artist123'], ready: '#view-overview' },
  { name: 'Licensee portal', path: '/licensee/', login: ['radio@royaltyhub.com', 'licensee123'], ready: '#view-licences' },
  { name: 'Public dashboard', path: '/public/', ready: '#pFlow' }
];

// Network presets used by Chrome DevTools.
const NETWORKS = {
  none: null,
  'Fast 3G': { latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 },
  'Slow 3G': { latency: 400, downloadThroughput: (500 * 1024) / 8, uploadThroughput: (500 * 1024) / 8 }
};
const HARDWARE = [
  { name: 'High-end (no throttling)', cpu: 1, network: 'none' },
  { name: 'Mid-range (CPU ×4, Fast 3G)', cpu: 4, network: 'Fast 3G' },
  { name: 'Low-end (CPU ×6, Slow 3G)', cpu: 6, network: 'Slow 3G' }
];

function startServer() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'royalty-compat-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT, stdio: 'ignore',
    env: { ...process.env, PORT: String(PORT), DB_PATH: path.join(tmp, 'c.db'), UPLOAD_DIR: path.join(tmp, 'up'), RATE_LIMIT_MAX: '100000' }
  });
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const poll = async () => {
      try { if ((await fetch(`${BASE}/api/health`)).ok) return resolve(child); } catch (e) { /* not up */ }
      if (Date.now() - t0 > 30000) return reject(new Error('server did not start'));
      return setTimeout(poll, 150);
    };
    poll();
  });
}

async function login(page, item, timeout = 20000) {
  await page.goto(BASE + item.path);
  if (item.login) {
    await page.fill('#loginForm input[name=email]', item.login[0]);
    await page.fill('#loginForm input[name=password]', item.login[1]);
    await page.click('#loginForm button[type=submit]');
  }
  await page.waitForSelector(item.ready, { state: 'visible', timeout });
  await page.waitForLoadState('networkidle');
}

async function compatibility(engineName, browser) {
  const rows = [];
  for (const profile of PROFILES) {
    // Firefox does not support "isMobile"; keep the size and touch settings.
    const options = engineName === 'firefox' ? { ...profile.options, isMobile: undefined } : profile.options;
    const context = await browser.newContext(options);
    if (process.env.BLOCK_EXTERNAL) await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
    for (const item of PAGES) {
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('console', (msg) => { if (msg.type() === 'error' && !/fonts\.g/.test(msg.text()) && !/ERR_FAILED/.test(msg.text())) errors.push(msg.text()); });
      const started = Date.now();
      let ok = true;
      try { await login(page, item); } catch (error) { ok = false; errors.push(error.message.split('\n')[0]); }
      const ms = Date.now() - started;
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      const file = `${engineName}-${profile.name.replace(/[^a-z0-9]+/gi, '-')}-${item.name.replace(/[^a-z0-9]+/gi, '-')}.png`.toLowerCase();
      await page.screenshot({ path: path.join(RESULTS, 'screens', file) });
      rows.push({ browser: `${engineName} ${browser.version()}`, profile: profile.name, page: item.name, works: ok && errors.length === 0, sidewaysScrollPx: overflow, ms, errors: errors.slice(0, 3), screenshot: `screens/${file}` });
      await page.close();
    }
    await context.close();
  }
  return rows;
}

async function performanceProfiles(browser) {
  const rows = [];
  for (const hw of HARDWARE) {
    for (const item of [PAGES[3], PAGES[0]]) {
      const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
      if (process.env.BLOCK_EXTERNAL) await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      await cdp.send('Network.enable');
      await cdp.send('Performance.enable');
      if (hw.cpu > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: hw.cpu });
      if (NETWORKS[hw.network]) await cdp.send('Network.emulateNetworkConditions', { offline: false, ...NETWORKS[hw.network] });
      let bytes = 0;
      cdp.on('Network.loadingFinished', (event) => { bytes += event.encodedDataLength; });

      const started = Date.now();
      await login(page, item, 120000); // slow profiles need more time
      const totalMs = Date.now() - started;
      const timing = await page.evaluate(() => {
        const nav = performance.getEntriesByType('navigation')[0];
        const fcp = performance.getEntriesByName('first-contentful-paint')[0];
        return { domContentLoaded: Math.round(nav.domContentLoadedEventEnd), load: Math.round(nav.loadEventEnd), fcp: fcp ? Math.round(fcp.startTime) : null };
      });
      const metrics = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
      rows.push({
        hardware: hw.name, page: item.name, fcpMs: timing.fcp, domContentLoadedMs: timing.domContentLoaded, loadMs: timing.load,
        readyMs: totalMs, jsHeapMB: +(metrics.JSHeapUsedSize / 1048576).toFixed(1), domNodes: metrics.Nodes, transferredKB: Math.round(bytes / 1024)
      });
      await context.close();
    }
  }
  return rows;
}

async function main() {
  fs.mkdirSync(path.join(RESULTS, 'screens'), { recursive: true });
  const server = await startServer();
  const report = { date: new Date().toISOString(), machine: `${os.cpus()[0].model}, ${os.cpus().length} cores, ${Math.round(os.totalmem() / 1073741824)} GB, ${os.type()} ${os.release()}`, compatibility: [], performance: [] };
  try {
    for (const engineName of (process.env.BROWSERS || 'chromium').split(',')) {
      let browser;
      try { browser = await ENGINES[engineName].launch(); } catch (error) {
        console.log(`${engineName}: not installed here (${error.message.split('\n')[0]})`);
        report.compatibility.push({ browser: engineName, profile: '-', page: '-', works: null, errors: ['browser not installed on this machine'] });
        continue;
      }
      report.compatibility.push(...await compatibility(engineName, browser));
      if (engineName === 'chromium') report.performance = await performanceProfiles(browser);
      await browser.close();
    }
  } finally {
    server.kill();
  }

  fs.writeFileSync(path.join(RESULTS, 'browser-check.json'), JSON.stringify(report, null, 2));
  const md = [
    '# Compatibility and performance results', '', `Date: ${report.date}  `, `Machine: ${report.machine}`, '',
    '## Screens and browsers', '',
    '| Browser | Screen | Portal | Works | Sideways scroll (px) | Ready in (ms) |', '|---|---|---|---|---|---|',
    ...report.compatibility.map((r) => `| ${r.browser} | ${r.profile} | ${r.page} | ${r.works === null ? 'not tested' : r.works ? 'yes' : `NO: ${r.errors.join('; ')}`} | ${r.sidewaysScrollPx ?? '-'} | ${r.ms ?? '-'} |`), '',
    '## Simulated hardware and networks (Chromium, 1366×768)', '',
    '| Hardware profile | Page | First paint (ms) | DOM ready (ms) | Load (ms) | Usable after login (ms) | JS memory (MB) | DOM nodes | Data (KB) |',
    '|---|---|---|---|---|---|---|---|---|',
    ...report.performance.map((r) => `| ${r.hardware} | ${r.page} | ${r.fcpMs} | ${r.domContentLoadedMs} | ${r.loadMs} | ${r.readyMs} | ${r.jsHeapMB} | ${r.domNodes} | ${r.transferredKB} |`)
  ].join('\n');
  fs.writeFileSync(path.join(RESULTS, 'browser-check.md'), `${md}\n`);
  console.log(md);
}

main().catch((error) => { console.error(error); process.exit(1); });
