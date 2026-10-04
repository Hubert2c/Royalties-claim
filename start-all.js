const { spawn } = require('child_process');

function startProcess(script) {
  const child = spawn(process.execPath, [script], {
    stdio: 'inherit'
  });

  child.on('exit', (code, signal) => {
    if (signal) {
      console.log(`${script} exited from signal: ${signal}`);
      process.exit(1);
    }

    if (code !== 0) {
      process.exit(code || 1);
    }
  });

  return child;
}

const admin = startProcess('server.js');
const artist = startProcess('artist-server.js');

function shutdown() {
  admin.kill('SIGINT');
  artist.kill('SIGINT');
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
