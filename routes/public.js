// =============================================================================
// routes/public.js — public transparency data (no login needed)
// -----------------------------------------------------------------------------
// FR-12: "publish aggregate collection and distribution reports on a public
// dashboard". Only totals are published — never personal data or payout details.
// Also:
//   * the public "unclaimed" list (usage that matched no registered work), so
//     creators can recognise and claim their songs (FR-9)
//   * a clearance-code checker, so broadcasters and permit offices can confirm
//     an advert or event is licensed (Table 7)
// =============================================================================

const express = require('express');
const { db } = require('../database');
const { dashboardCache } = require('../lib/util/TtlCache');

const router = express.Router();

router.get('/summary', async (req, res) => {
  // Cached for a few seconds (see lib/util/TtlCache.js): this page is public and may be busy.
  res.json(await dashboardCache.get('public-summary', () => buildSummary()));
});

async function buildSummary() {
  const one = async (sql) => Number(Object.values(await db.prepare(sql).get())[0] || 0);
  const summary = {
    collected: await one('SELECT COALESCE(SUM(amount), 0) AS v FROM payments'),
    distributedPaid: await one("SELECT COALESCE(SUM(rl.amount), 0) AS v FROM royalty_lines rl JOIN distribution_runs r ON r.id = rl.run_id WHERE rl.paid_status = 'paid' AND r.status <> 'cancelled'"),
    adminFees: await one("SELECT COALESCE(SUM(admin_fee), 0) AS v FROM distribution_runs WHERE status IN ('approved', 'paid')"),
    held: await one("SELECT COALESCE(SUM(held_amount), 0) AS v FROM distribution_runs WHERE status IN ('approved', 'paid')"),
    registeredWorks: await one('SELECT COUNT(*) AS v FROM works'),
    rightsHolders: await one('SELECT COUNT(*) AS v FROM rights_holders'),
    licensees: await one('SELECT COUNT(*) AS v FROM licensees'),
    paidLicences: await one("SELECT COUNT(*) AS v FROM licences WHERE status = 'paid'"),
    unmatchedUsage: await one("SELECT COUNT(*) AS v FROM usage_events WHERE status = 'unmatched'")
  };

  // Only approved/paid runs are published (drafts may still change).
  const runs = await db.prepare(`SELECT period, total_pool, admin_fee_rate, admin_fee, distributable, held_amount, usage_count, status, approved_at, paid_at
    FROM distribution_runs WHERE status IN ('approved', 'paid') ORDER BY period DESC`).all();

  const collectionsByCategory = await db.prepare(`SELECT li.category, COALESCE(SUM(p.amount), 0) AS amount
    FROM payments p JOIN licences l ON l.id = p.licence_id JOIN licensees li ON li.id = l.licensee_id
    GROUP BY li.category ORDER BY amount DESC`).all();

  // Last 12 months of collections and payouts, for the public chart.
  const { lastMonths, fillMonths } = require('../lib/util/periods');
  const months = lastMonths(12);
  const collectionsRows = await db.prepare(`SELECT substr(paid_at, 1, 7) AS period, SUM(amount) AS value FROM payments
    WHERE substr(paid_at, 1, 7) >= ? GROUP BY substr(paid_at, 1, 7)`).all(months[0]);
  const payoutRows = await db.prepare(`SELECT r.period AS period, SUM(rl.amount) AS value FROM royalty_lines rl JOIN distribution_runs r ON r.id = rl.run_id
    WHERE rl.paid_status = 'paid' AND r.period >= ? GROUP BY r.period`).all(months[0]);

  return { summary, runs, collectionsByCategory, monthly: { months, collections: fillMonths(months, collectionsRows), payouts: fillMonths(months, payoutRows) } };
}

// Unmatched usage — title/artist as reported, where and when. No personal data.
router.get('/unclaimed', async (req, res) => {
  const usage = await db.prepare(`SELECT u.id, u.raw_title, u.raw_artist, u.isrc, u.source, u.played_at, u.period, l.name AS licensee_name, l.category
    FROM usage_events u LEFT JOIN licensees l ON l.id = u.licensee_id WHERE u.status = 'unmatched' ORDER BY u.played_at DESC LIMIT 300`).all();
  res.json({ usage });
});

// Is this clearance code valid? (used before an advert airs or an event permit is issued)
router.get('/clearance/:code', async (req, res) => {
  const licence = await db.prepare(`SELECT l.status, l.period_start, l.period_end, l.description, li.name AS licensee_name, li.category, t.name AS tariff_name
    FROM licences l JOIN licensees li ON li.id = l.licensee_id JOIN tariffs t ON t.id = l.tariff_id WHERE l.clearance_code = ?`)
    .get(String(req.params.code || '').trim().toUpperCase());
  if (!licence) return res.json({ valid: false, message: 'No licence has this clearance code.' });

  const today = new Date().toISOString().slice(0, 10);
  const inPeriod = licence.period_start <= today && licence.period_end >= today;
  const valid = licence.status === 'paid' && inPeriod;
  let message = 'Valid: the licence is paid and in force.';
  if (licence.status !== 'paid') message = 'Not valid yet: the licence fee has not been paid.';
  else if (!inPeriod) message = 'Not valid: the licence period has ended or not started.';
  res.json({ valid, message, licence });
});

module.exports = router;
