// =============================================================================
// database.js — the one shared database connection
// -----------------------------------------------------------------------------
//   db/adapters.js  SQLite or PostgreSQL behind the same interface
//   db/schema.js    the 18 tables (Figure 4 of the capstone document)
//   db/seed.js      demo data for the prototype
//
// SQLite is used by default (a single file in ./data). Set DATABASE_URL (or
// DB_CLIENT=postgres) to use PostgreSQL instead.
// =============================================================================

const crypto = require('crypto');
const { createDatabase } = require('./db/adapters');
const { SCHEMA } = require('./db/schema');

const db = createDatabase();

/** Short, readable unique IDs such as "WRK-9F3A1C2B". */
function newId(prefix) {
  return `${prefix}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

/** The current time as an ISO string, e.g. "2026-10-25T08:15:00.000Z". */
function nowIso() {
  return new Date().toISOString();
}

/** Create the tables (if missing) and load the demo data on the first start. */
async function initializeDatabase() {
  // Both SQLite and Postgres accept the whole script at once (no parameters).
  await db.exec(SCHEMA);
  if (process.env.SKIP_SEED !== 'true') {
    const { seedDemoData } = require('./db/seed'); // loaded here to avoid a circular require
    await seedDemoData({ db, newId, nowIso });
  }
}

module.exports = { db, initializeDatabase, newId, nowIso };
