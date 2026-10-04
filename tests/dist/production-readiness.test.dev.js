"use strict";

var test = require('node:test');

var assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret';
process.env.PORT = '3456';

var _require = require('../server'),
    app = _require.app,
    server = _require.server;

test.after(function () {
  server.close();
});
assert.ok(app, 'Server should expose the Express app for production config tests.');

function request(path) {
  var options,
      base,
      _args = arguments;
  return regeneratorRuntime.async(function request$(_context) {
    while (1) {
      switch (_context.prev = _context.next) {
        case 0:
          options = _args.length > 1 && _args[1] !== undefined ? _args[1] : {};
          base = 'http://127.0.0.1:3456';
          return _context.abrupt("return", fetch("".concat(base).concat(path), options));

        case 3:
        case "end":
          return _context.stop();
      }
    }
  });
}

test('app exposes health endpoint', function _callee() {
  var res, json;
  return regeneratorRuntime.async(function _callee$(_context2) {
    while (1) {
      switch (_context2.prev = _context2.next) {
        case 0:
          _context2.next = 2;
          return regeneratorRuntime.awrap(request('/api/health'));

        case 2:
          res = _context2.sent;
          assert.equal(res.status, 200);
          _context2.next = 6;
          return regeneratorRuntime.awrap(res.json());

        case 6:
          json = _context2.sent;
          assert.equal(json.service, 'royalty-claims-api');

        case 8:
        case "end":
          return _context2.stop();
      }
    }
  });
});
test('registration validates email format', function _callee2() {
  var res, json;
  return regeneratorRuntime.async(function _callee2$(_context3) {
    while (1) {
      switch (_context3.prev = _context3.next) {
        case 0:
          _context3.next = 2;
          return regeneratorRuntime.awrap(request('/api/auth/register', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              name: 'Test User',
              email: 'bad-email',
              password: 'password123'
            })
          }));

        case 2:
          res = _context3.sent;
          assert.equal(res.status, 400);
          _context3.next = 6;
          return regeneratorRuntime.awrap(res.json());

        case 6:
          json = _context3.sent;
          assert.match(json.message, /valid email/i);

        case 8:
        case "end":
          return _context3.stop();
      }
    }
  });
});
//# sourceMappingURL=production-readiness.test.dev.js.map
