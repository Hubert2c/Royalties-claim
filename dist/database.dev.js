"use strict";

var fs = require('fs');

var path = require('path');

var Database = require('better-sqlite3');

var bcrypt = require('bcryptjs');

var dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
fs.mkdirSync(dataDir, {
  recursive: true
});
var dbPath = process.env.DB_PATH || path.join(dataDir, 'royalties.db');
var db = new Database(dbPath);

function initializeDatabase() {
  db.exec("\n    CREATE TABLE IF NOT EXISTS users (\n      id TEXT PRIMARY KEY,\n      name TEXT NOT NULL,\n      email TEXT UNIQUE NOT NULL,\n      password_hash TEXT NOT NULL,\n      role TEXT NOT NULL,\n      created_at TEXT NOT NULL\n    );\n\n    CREATE TABLE IF NOT EXISTS claims (\n      id TEXT PRIMARY KEY,\n      user_id TEXT NOT NULL,\n      artist TEXT NOT NULL,\n      track TEXT NOT NULL,\n      amount REAL NOT NULL,\n      status TEXT NOT NULL,\n      submitted_date TEXT NOT NULL,\n      notes TEXT,\n      file_name TEXT,\n      created_at TEXT NOT NULL,\n      FOREIGN KEY(user_id) REFERENCES users(id)\n    );\n  ");
  var adminExists = db.prepare('SELECT 1 FROM users WHERE email = ?').get('admin@royaltyhub.com');

  if (!adminExists) {
    var adminId = 'user-admin';
    db.prepare("\n      INSERT INTO users (id, name, email, password_hash, role, created_at)\n      VALUES (?, ?, ?, ?, ?, ?)\n    ").run(adminId, 'Admin User', 'admin@royaltyhub.com', bcrypt.hashSync('admin123', 10), 'admin', new Date().toISOString());
  }

  var reviewerExists = db.prepare('SELECT 1 FROM users WHERE email = ?').get('reviewer@royaltyhub.com');

  if (!reviewerExists) {
    db.prepare("\n      INSERT INTO users (id, name, email, password_hash, role, created_at)\n      VALUES (?, ?, ?, ?, ?, ?)\n    ").run('user-reviewer', 'Review Officer', 'reviewer@royaltyhub.com', bcrypt.hashSync('reviewer123', 10), 'reviewer', new Date().toISOString());
  }

  var claimantExists = db.prepare('SELECT 1 FROM users WHERE email = ?').get('artist@royaltyhub.com');

  if (!claimantExists) {
    db.prepare("\n      INSERT INTO users (id, name, email, password_hash, role, created_at)\n      VALUES (?, ?, ?, ?, ?, ?)\n    ").run('user-claimant', 'Munezero Hubert', 'artist@royaltyhub.com', bcrypt.hashSync('artist123', 10), 'claimant', new Date().toISOString());
  }

  var sampleClaims = db.prepare('SELECT 1 FROM claims LIMIT 1').get();

  if (!sampleClaims) {
    db.prepare("\n      INSERT INTO claims (id, user_id, artist, track, amount, status, submitted_date, notes, file_name, created_at)\n      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)\n    ").run('RC-1042', 'user-claimant', 'Munezero Hubert', 'Midnight Echo', 3200, 'Pending', '2026-10-01', 'Royalty adjustment for streaming platform sales during Q3.', null, new Date().toISOString());
    db.prepare("\n      INSERT INTO claims (id, user_id, artist, track, amount, status, submitted_date, notes, file_name, created_at)\n      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)\n    ").run('RC-1045', 'user-claimant', 'Aline Kay', 'Golden Hours', 1850, 'Approved', '2026-09-28', 'Approved after verification of distribution statements.', null, new Date().toISOString());
    db.prepare("\n      INSERT INTO claims (id, user_id, artist, track, amount, status, submitted_date, notes, file_name, created_at)\n      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)\n    ").run('RC-1048', 'user-claimant', 'T. Mwesigye', 'City Lights', 2400, 'Rejected', '2026-09-22', 'Missing expenditure document and inaccurate claim values.', null, new Date().toISOString());
  }
}

module.exports = {
  db: db,
  initializeDatabase: initializeDatabase
};
//# sourceMappingURL=database.dev.js.map
