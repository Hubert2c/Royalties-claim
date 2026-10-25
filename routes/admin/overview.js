// =============================================================================
// routes/admin/overview.js — Overview numbers, 12-month trends, live airplay feed and Ctrl+K search.
// Mounted under /api/admin by routes/admin/index.js (admins and auditors may
// read; only admins may change things).
// =============================================================================

const express = require('express');
const { dashboardCache } = require('../../lib/util/TtlCache');
const { db } = require('../../database');
const { lastMonths, fillMonths } = require('../../lib/util/periods');
const { getAdminFeeRate } = require('../../lib/services');
const { rwf, currentPeriod } = require('../../lib/util/format');

const router = express.Router();

// --- Overview --------------------------------------------------------------------

router.get('/overview', async (req, res) => {
  // Cached for a few seconds (see lib/util/TtlCache.js): many people may refresh at once.
  const overview = await dashboardCache.get('admin-overview', () => buildOverview());
  return res.json({ overview });
});

async function buildOverview() {
  const one = async (sql, ...params) => Number(Object.values(await db.prepare(sql).get(...params))[0] || 0);
  const period = currentPeriod();

  const overview = {
    period,
    collectedTotal: await one('SELECT COALESCE(SUM(amount), 0) AS v FROM payments'),
    collectedThisPeriod: await one('SELECT COALESCE(SUM(amount), 0) AS v FROM payments WHERE substr(paid_at, 1, 7) = ?', period),
    distributedPaid: await one("SELECT COALESCE(SUM(amount), 0) AS v FROM royalty_lines rl JOIN distribution_runs r ON r.id = rl.run_id WHERE rl.paid_status = 'paid' AND r.status <> 'cancelled'"),
    adminFees: await one("SELECT COALESCE(SUM(admin_fee), 0) AS v FROM distribution_runs WHERE status IN ('approved', 'paid')"),
    heldAmount: await one("SELECT COALESCE(SUM(held_amount), 0) AS v FROM distribution_runs WHERE status IN ('approved', 'paid')"),
    worksCount: await one('SELECT COUNT(*) AS v FROM works'),
    activeWorks: await one("SELECT COUNT(*) AS v FROM works WHERE status = 'active'"),
    holdersCount: await one('SELECT COUNT(*) AS v FROM rights_holders'),
    licenseesCount: await one('SELECT COUNT(*) AS v FROM licensees'),
    pendingLicences: await one("SELECT COUNT(*) AS v FROM licences WHERE status = 'applied'"),
    unpaidInvoices: await one("SELECT COUNT(*) AS v FROM licences WHERE status = 'invoiced'"),
    pendingClaims: await one("SELECT COUNT(*) AS v FROM usage_claims WHERE status = 'pending'"),
    openDisputes: await one("SELECT COUNT(*) AS v FROM disputes WHERE status = 'open'"),
    usageThisPeriod: await one('SELECT COUNT(*) AS v FROM usage_events WHERE period = ?', period),
    unmatchedUsage: await one("SELECT COUNT(*) AS v FROM usage_events WHERE status = 'unmatched'"),
    adminFeeRate: await getAdminFeeRate()
  };
  overview.usageBySource = await db.prepare('SELECT source, COUNT(*) AS count FROM usage_events WHERE period = ? GROUP BY source ORDER BY count DESC').all(period);
  overview.recentAudit = await db.prepare('SELECT seq, actor_role, action, entity, entity_id, created_at FROM audit_log ORDER BY seq DESC LIMIT 8').all();
  return overview;
}

// --- Charts, live feed and search -----------------------------------------------

// GET /api/admin/trends — last 12 months of collections, payouts and plays (for the charts)
router.get('/trends', async (req, res) => {
  const months = lastMonths(12);
  const first = months[0];
  const collections = await db.prepare(`SELECT substr(paid_at, 1, 7) AS period, SUM(amount) AS value FROM payments
    WHERE substr(paid_at, 1, 7) >= ? GROUP BY substr(paid_at, 1, 7)`).all(first);
  const payouts = await db.prepare(`SELECT r.period AS period, SUM(rl.amount) AS value FROM royalty_lines rl JOIN distribution_runs r ON r.id = rl.run_id
    WHERE rl.paid_status = 'paid' AND r.period >= ? GROUP BY r.period`).all(first);
  const plays = await db.prepare('SELECT period, COUNT(*) AS value FROM usage_events WHERE period >= ? GROUP BY period').all(first);
  res.json({ months, collections: fillMonths(months, collections), payouts: fillMonths(months, payouts), plays: fillMonths(months, plays) });
});

// GET /api/admin/live — the latest detected / reported plays (polled every few seconds)
router.get('/live', async (req, res) => {
  const plays = await db.prepare(`
    SELECT u.id, u.played_at, u.created_at, u.source, u.confidence, u.status, u.raw_title, u.raw_artist,
      rec.title AS recording_title, rec.performer, l.name AS licensee_name, l.category
    FROM usage_events u LEFT JOIN recordings rec ON rec.id = u.recording_id LEFT JOIN licensees l ON l.id = u.licensee_id
    ORDER BY u.created_at DESC, u.played_at DESC LIMIT 12
  `).all();
  res.json({ plays });
});

// GET /api/admin/search?q=... — quick search (Ctrl+K) across the registry
router.get('/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ results: [] });
  const like = `%${q.toLowerCase()}%`;
  const results = [];
  const add = (rows, type, view, toLabel) => rows.forEach((row) => results.push({ type, view, id: row.id, ...toLabel(row) }));

  add(await db.prepare('SELECT id, title, iswc, status FROM works WHERE lower(title) LIKE ? OR lower(iswc) LIKE ? LIMIT 5').all(like, like),
    'Work', 'catalogue', (w) => ({ title: w.title, detail: `${w.iswc || 'No ISWC'}, ${w.status.replace('_', ' ')}` }));
  add(await db.prepare('SELECT r.id, r.title, r.isrc, r.performer FROM recordings r WHERE lower(r.isrc) LIKE ? OR lower(r.performer) LIKE ? LIMIT 5').all(like, like),
    'Recording', 'catalogue', (r) => ({ title: r.title, detail: `${r.performer || ''} ${r.isrc || ''}`.trim() }));
  add(await db.prepare('SELECT id, full_name, ipi_number, holder_type FROM rights_holders WHERE lower(full_name) LIKE ? OR lower(ipi_number) LIKE ? LIMIT 5').all(like, like),
    'Rights holder', 'catalogue', (h) => ({ title: h.full_name, detail: `${h.holder_type}${h.ipi_number ? `, IPI ${h.ipi_number}` : ''}` }));
  add(await db.prepare('SELECT id, name, category, tin FROM licensees WHERE lower(name) LIKE ? OR lower(tin) LIKE ? LIMIT 5').all(like, like),
    'Licensee', 'licences', (l) => ({ title: l.name, detail: `${l.category}${l.tin ? `, TIN ${l.tin}` : ''}` }));
  add(await db.prepare('SELECT id, period, status, distributable FROM distribution_runs WHERE lower(id) LIKE ? OR period LIKE ? LIMIT 5').all(like, like),
    'Distribution run', 'runs', (r) => ({ title: `${r.id} (${r.period})`, detail: `${r.status}, ${rwf(r.distributable)} for creators` }));
  add(await db.prepare('SELECT id, clearance_code, status, fee_due FROM licences WHERE lower(clearance_code) LIKE ? OR lower(id) LIKE ? LIMIT 5').all(like, like),
    'Licence', 'licences', (l) => ({ title: l.clearance_code || l.id, detail: `${l.status}, ${rwf(l.fee_due)}` }));
  res.json({ results });
});

module.exports = router;
