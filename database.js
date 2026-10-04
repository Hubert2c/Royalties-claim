const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const usePostgres = !!process.env.DATABASE_URL || String(process.env.DB_CLIENT || '').toLowerCase() === 'postgres';

function normalizeParams(sql, params) {
  const flatParams = Array.isArray(params[0]) && params.length === 1 ? params[0] : params;
  let index = 0;
  const normalizedSql = sql.replace(/\?/g, () => `$${++index}`);
  return { sql: normalizedSql, params: flatParams };
}

function createSqliteDb() {
  const Database = require('better-sqlite3');
  const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
  fs.mkdirSync(dataDir, { recursive: true });

  const dbPath = process.env.DB_PATH || path.join(dataDir, 'royalties.db');
  return new Database(dbPath);
}

function createPostgresDb() {
  const { Pool } = require('pg');
  const connectionString = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/royalties_claim';
  const pool = new Pool({
    connectionString,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
  });

  const statementApi = (sql) => ({
    async get(...args) {
      const { sql: querySql, params } = normalizeParams(sql, args);
      const result = await pool.query(querySql, params);
      return result.rows[0] || null;
    },
    async all(...args) {
      const { sql: querySql, params } = normalizeParams(sql, args);
      const result = await pool.query(querySql, params);
      return result.rows;
    },
    async run(...args) {
      const { sql: querySql, params } = normalizeParams(sql, args);
      const result = await pool.query(querySql, params);
      return {
        changes: Number(result.rowCount || 0),
        lastInsertRowid: result.rows?.[0]?.id || null
      };
    }
  });

  return {
    prepare: statementApi,
    async exec(sql, ...args) {
      const { sql: querySql, params } = normalizeParams(sql, args);
      await pool.query(querySql, params);
    },
    close: () => pool.end()
  };
}

const db = usePostgres ? createPostgresDb() : createSqliteDb();

async function initializeDatabase() {
  if (usePostgres) {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);

    await db.exec(`
      CREATE TABLE IF NOT EXISTS claims (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        artist TEXT NOT NULL,
        track TEXT NOT NULL,
        amount REAL NOT NULL,
        status TEXT NOT NULL,
        submitted_date TEXT NOT NULL,
        notes TEXT,
        file_name TEXT,
        created_at TEXT NOT NULL
      );
    `);

    const adminExists = await db.prepare('SELECT 1 FROM users WHERE email = ?').get('admin@royaltyhub.com');
    if (!adminExists) {
      await db.prepare(`
        INSERT INTO users (id, name, email, password_hash, role, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        'user-admin',
        'Admin User',
        'admin@royaltyhub.com',
        bcrypt.hashSync('admin123', 10),
        'admin',
        new Date().toISOString()
      );
    }

    const reviewerExists = await db.prepare('SELECT 1 FROM users WHERE email = ?').get('reviewer@royaltyhub.com');
    if (!reviewerExists) {
      await db.prepare(`
        INSERT INTO users (id, name, email, password_hash, role, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        'user-reviewer',
        'Review Officer',
        'reviewer@royaltyhub.com',
        bcrypt.hashSync('reviewer123', 10),
        'reviewer',
        new Date().toISOString()
      );
    }

    const claimantExists = await db.prepare('SELECT 1 FROM users WHERE email = ?').get('artist@royaltyhub.com');
    if (!claimantExists) {
      await db.prepare(`
        INSERT INTO users (id, name, email, password_hash, role, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        'user-claimant',
        'Munezero Hubert',
        'artist@royaltyhub.com',
        bcrypt.hashSync('artist123', 10),
        'claimant',
        new Date().toISOString()
      );
    }

    const sampleClaims = await db.prepare('SELECT 1 FROM claims LIMIT 1').get();
    if (!sampleClaims) {
      await db.prepare(`
        INSERT INTO claims (id, user_id, artist, track, amount, status, submitted_date, notes, file_name, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'RC-1042',
        'user-claimant',
        'Munezero Hubert',
        'Midnight Echo',
        3200,
        'Pending',
        '2026-10-01',
        'Royalty adjustment for streaming platform sales during Q3.',
        null,
        new Date().toISOString()
      );

      await db.prepare(`
        INSERT INTO claims (id, user_id, artist, track, amount, status, submitted_date, notes, file_name, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'RC-1045',
        'user-claimant',
        'Aline Kay',
        'Golden Hours',
        1850,
        'Approved',
        '2026-09-28',
        'Approved after verification of distribution statements.',
        null,
        new Date().toISOString()
      );

      await db.prepare(`
        INSERT INTO claims (id, user_id, artist, track, amount, status, submitted_date, notes, file_name, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'RC-1048',
        'user-claimant',
        'T. Mwesigye',
        'City Lights',
        2400,
        'Rejected',
        '2026-09-22',
        'Missing expenditure document and inaccurate claim values.',
        null,
        new Date().toISOString()
      );
    }
    return;
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS claims (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      artist TEXT NOT NULL,
      track TEXT NOT NULL,
      amount REAL NOT NULL,
      status TEXT NOT NULL,
      submitted_date TEXT NOT NULL,
      notes TEXT,
      file_name TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id)
    );
  `);

  const adminExists = db.prepare('SELECT 1 FROM users WHERE email = ?').get('admin@royaltyhub.com');
  if (!adminExists) {
    const adminId = 'user-admin';
    db.prepare(`
      INSERT INTO users (id, name, email, password_hash, role, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      adminId,
      'Admin User',
      'admin@royaltyhub.com',
      bcrypt.hashSync('admin123', 10),
      'admin',
      new Date().toISOString()
    );
  }

  const reviewerExists = db.prepare('SELECT 1 FROM users WHERE email = ?').get('reviewer@royaltyhub.com');
  if (!reviewerExists) {
    db.prepare(`
      INSERT INTO users (id, name, email, password_hash, role, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      'user-reviewer',
      'Review Officer',
      'reviewer@royaltyhub.com',
      bcrypt.hashSync('reviewer123', 10),
      'reviewer',
      new Date().toISOString()
    );
  }

  const claimantExists = db.prepare('SELECT 1 FROM users WHERE email = ?').get('artist@royaltyhub.com');
  if (!claimantExists) {
    db.prepare(`
      INSERT INTO users (id, name, email, password_hash, role, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      'user-claimant',
      'Munezero Hubert',
      'artist@royaltyhub.com',
      bcrypt.hashSync('artist123', 10),
      'claimant',
      new Date().toISOString()
    );
  }

  const sampleClaims = db.prepare('SELECT 1 FROM claims LIMIT 1').get();
  if (!sampleClaims) {
    db.prepare(`
      INSERT INTO claims (id, user_id, artist, track, amount, status, submitted_date, notes, file_name, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'RC-1042',
      'user-claimant',
      'Munezero Hubert',
      'Midnight Echo',
      3200,
      'Pending',
      '2026-10-01',
      'Royalty adjustment for streaming platform sales during Q3.',
      null,
      new Date().toISOString()
    );

    db.prepare(`
      INSERT INTO claims (id, user_id, artist, track, amount, status, submitted_date, notes, file_name, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'RC-1045',
      'user-claimant',
      'Aline Kay',
      'Golden Hours',
      1850,
      'Approved',
      '2026-09-28',
      'Approved after verification of distribution statements.',
      null,
      new Date().toISOString()
    );

    db.prepare(`
      INSERT INTO claims (id, user_id, artist, track, amount, status, submitted_date, notes, file_name, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'RC-1048',
      'user-claimant',
      'T. Mwesigye',
      'City Lights',
      2400,
      'Rejected',
      '2026-09-22',
      'Missing expenditure document and inaccurate claim values.',
      null,
      new Date().toISOString()
    );
  }
}

module.exports = { db, initializeDatabase };
