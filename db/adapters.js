// =============================================================================
// db/adapters.js — one small database interface, two implementations
// -----------------------------------------------------------------------------
// The platform runs on SQLite (local development, the demo) or PostgreSQL
// (staging/production). Both adapters expose exactly the same methods, so the
// rest of the code never needs to know which database is in use:
//
//     await db.prepare(sql).get(...params)   -> first row or null
//     await db.prepare(sql).all(...params)   -> array of rows
//     await db.prepare(sql).run(...params)   -> { changes }
//     await db.exec(sql)                     -> run a script (no params)
//
// SQL is always written with "?" placeholders; PostgresAdapter converts them to
// $1, $2, ... This is the Adapter pattern + polymorphism: DatabaseAdapter is
// the abstract base, and createDatabase() picks the concrete class.
// =============================================================================

const fs = require('fs');
const path = require('path');

class DatabaseAdapter {
  constructor(kind) {
    if (new.target === DatabaseAdapter) throw new TypeError('DatabaseAdapter is abstract; use a subclass.');
    this.kind = kind;
  }

  /** @returns {{get: Function, all: Function, run: Function}} */
  prepare(sql) { throw new Error(`${this.constructor.name} must implement prepare(${typeof sql}).`); }

  async exec(sql) { throw new Error(`${this.constructor.name} must implement exec(${typeof sql}).`); }

  close() {}
}

class SqliteAdapter extends DatabaseAdapter {
  /** @param {string} dbPath - path of the .db file (created if missing) */
  constructor(dbPath) {
    super('sqlite');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.raw = SqliteAdapter.open(dbPath);
    this.raw.exec('PRAGMA foreign_keys = ON;');
    if (dbPath !== ':memory:') {
      // Performance (found by the load test): write-ahead logging lets reads
      // continue during writes, and NORMAL sync avoids a disk flush on every
      // single insert while staying safe against corruption.
      this.raw.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    }
  }

  /**
   * Prefer the "better-sqlite3" package; if it is not installed or could not be
   * compiled on this machine, fall back to Node's built-in "node:sqlite"
   * (Node 22.5+), which has an almost identical API.
   */
  static open(dbPath) {
    try {
      const BetterSqlite = require('better-sqlite3');
      return new BetterSqlite(dbPath);
    } catch (error) {
      const { DatabaseSync } = require('node:sqlite');
      return new DatabaseSync(dbPath);
    }
  }

  // SQLite is synchronous; the methods are async so callers can always "await".
  prepare(sql) {
    const statement = this.raw.prepare(sql);
    return {
      async get(...args) { return statement.get(...args) || null; },
      async all(...args) { return statement.all(...args); },
      async run(...args) { return { changes: Number(statement.run(...args).changes || 0) }; }
    };
  }

  async exec(sql) { this.raw.exec(sql); }

  close() { this.raw.close(); }
}

class PostgresAdapter extends DatabaseAdapter {
  /** @param {string} connectionString */
  constructor(connectionString) {
    super('postgres');
    const pg = require('pg');
    // BIGINT (OID 20) comes back as a string by default; our amounts fit in a JS number.
    pg.types.setTypeParser(20, (value) => parseInt(value, 10));
    this.pool = new pg.Pool({
      connectionString,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
    });
  }

  /** Convert "?" placeholders into "$1, $2, ...". */
  static toPostgres(sql, params) {
    const flatParams = Array.isArray(params[0]) && params.length === 1 ? params[0] : params;
    let index = 0;
    return { sql: sql.replace(/\?/g, () => `$${++index}`), params: flatParams };
  }

  prepare(sql) {
    const query = async (args) => {
      const q = PostgresAdapter.toPostgres(sql, args);
      return this.pool.query(q.sql, q.params);
    };
    return {
      async get(...args) { return (await query(args)).rows[0] || null; },
      async all(...args) { return (await query(args)).rows; },
      async run(...args) { return { changes: Number((await query(args)).rowCount || 0) }; }
    };
  }

  async exec(sql) { await this.pool.query(sql); }

  close() { return this.pool.end(); }
}

/** Pick the adapter from the environment (DATABASE_URL or DB_CLIENT=postgres -> Postgres). */
function createDatabase(env = process.env, rootDir = path.join(__dirname, '..')) {
  const usePostgres = Boolean(env.DATABASE_URL) || String(env.DB_CLIENT || '').toLowerCase() === 'postgres';
  if (usePostgres) {
    return new PostgresAdapter(env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/royalty_hub');
  }
  const dataDir = path.resolve(env.DATA_DIR || path.join(rootDir, 'data'));
  return new SqliteAdapter(env.DB_PATH || path.join(dataDir, 'royalty_hub.db'));
}

module.exports = { DatabaseAdapter, SqliteAdapter, PostgresAdapter, createDatabase };
