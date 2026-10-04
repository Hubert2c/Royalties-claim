"use strict";

var _require = require('child_process'),
    spawn = _require.spawn;

function startProcess(script) {
  var child = spawn(process.execPath, [script], {
    stdio: 'inherit'
  });
  child.on('exit', function (code, signal) {
    if (signal) {
      console.log("".concat(script, " exited from signal: ").concat(signal));
      process.exit(1);
    }

    if (code !== 0) {
      process.exit(code || 1);
    }
  });
  return child;
}

var admin = startProcess('server.js');
var artist = startProcess('artist-server.js');

function shutdown() {
  admin.kill('SIGINT');
  artist.kill('SIGINT');
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
//# sourceMappingURL=start-all.dev.js.map
