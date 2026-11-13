// Vercel serverless entry point: the whole Express app (API + portal pages).
// Use Postgres on Vercel (set DATABASE_URL) — SQLite files do not persist there.
const { app } = require('../server');

module.exports = app;
