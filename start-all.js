// =============================================================================
// start-all.js — start the API + console (3001), artist portal (8000) and
// licensee portal (3002) together with one command: npm start
// =============================================================================

const { spawn } = require('child_process');
const path = require('path');

function startProcess(script) {
  const child = spawn(process.execPath, [path.join(__dirname, script)], { stdio: 'inherit' });
  child.on('exit', (code, signal) => {
    if (signal) console.log(`${script} stopped (${signal})`);
    else if (code !== 0) { console.error(`${script} exited with code ${code}`); process.exit(code || 1); }
  });
  return child;
}

const children = ['server.js', 'artist-server.js', 'licensee-server.js'].map(startProcess);

function shutdown() {
  children.forEach((child) => child.kill('SIGINT'));
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
