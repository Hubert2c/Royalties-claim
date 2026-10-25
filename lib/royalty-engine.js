// =============================================================================
// lib/royalty-engine.js — calculate a royalty distribution run
// -----------------------------------------------------------------------------
// Implements the flowchart in Figure 7 and requirement FR-6 of the document:
//
//   1. POOL      = all licence payments received during the period (YYYY-MM).
//   2. ADMIN FEE = POOL × admin fee rate. The rate can never exceed 30%
//                  (the 70/30 rule proposed in Section 3.2).
//   3. DISTRIBUTABLE = POOL − ADMIN FEE.
//   4. Every MATCHED usage event in the period gets an equal share of the
//      distributable money (one play = one unit). Unmatched usage is left out
//      and stays on the public "unclaimed" list.
//   5. Each usage event's value is divided between the rights holders of that
//      work according to their CONFIRMED splits.
//      If a work's splits are not fully confirmed (or do not total 100%), the
//      money is HELD — it is recorded, but not paid, until the splits are fixed.
//
// Every amount is a whole number of Rwf. To make sure the parts always add up
// to the whole (the document's "accuracy" requirement), money is divided with
// the largest-remainder method in allocate() below.
// =============================================================================

const { newId, nowIso } = require('../database');

const MAX_ADMIN_FEE_RATE = 0.30;

// Split `total` whole francs in proportion to `weights`, so that the results
// are whole numbers that add up EXACTLY to `total`.
// Example: allocate(100, [1, 1, 1]) -> [34, 33, 33]
function allocate(total, weights) {
  const sumWeights = weights.reduce((sum, w) => sum + w, 0);
  if (total <= 0 || sumWeights <= 0) return weights.map(() => 0);

  // Step 1: give everyone the whole-number part of their exact share.
  const exact = weights.map((w) => (total * w) / sumWeights);
  const result = exact.map((value) => Math.floor(value));
  let leftover = total - result.reduce((sum, value) => sum + value, 0);

  // Step 2: hand out the leftover francs one by one, biggest fractional part first.
  // Ties are broken by position so the result is always the same for the same input.
  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  for (let i = 0; leftover > 0; i += 1, leftover -= 1) {
    result[order[i % order.length].index] += 1;
  }
  return result;
}

// Is this list of splits complete? All confirmed and adding up to 100%.
function splitsAreComplete(splits) {
  if (!splits.length) return false;
  const allConfirmed = splits.every((split) => split.status === 'confirmed');
  const total = splits.reduce((sum, split) => sum + Number(split.share_percent), 0);
  return allConfirmed && Math.abs(total - 100) < 0.001;
}

// Read the inputs for a period from the database (no writes).
async function loadPeriodInputs(db, period) {
  const poolRow = await db.prepare(
    "SELECT COALESCE(SUM(amount), 0) AS total FROM payments WHERE substr(paid_at, 1, 7) = ?"
  ).get(period);

  const usage = await db.prepare(`
    SELECT u.id, u.recording_id, r.work_id
    FROM usage_events u
    JOIN recordings r ON r.id = u.recording_id
    WHERE u.period = ? AND u.status = 'matched'
    ORDER BY u.played_at ASC, u.id ASC
  `).all(period);

  const splitRows = await db.prepare(`
    SELECT s.work_id, s.holder_id, s.share_percent, s.status
    FROM splits s
    WHERE s.status <> 'rejected'
    ORDER BY s.work_id, s.holder_id
  `).all();

  // Group splits by work for quick lookup.
  const splitsByWork = {};
  for (const split of splitRows) {
    if (!splitsByWork[split.work_id]) splitsByWork[split.work_id] = [];
    splitsByWork[split.work_id].push(split);
  }

  return { pool: Number(poolRow.total), usage, splitsByWork };
}

// Pure calculation — no database access, so it is easy to test.
// Returns { pool, adminFee, distributable, held, lines: [...] }
function calculate({ pool, usage, splitsByWork }, adminFeeRate) {
  const rate = Math.min(Math.max(Number(adminFeeRate) || 0, 0), MAX_ADMIN_FEE_RATE);
  const adminFee = Math.round(pool * rate);
  const distributable = pool - adminFee;

  // Equal value per play (largest-remainder so the plays add up to `distributable`).
  const usageValues = allocate(distributable, usage.map(() => 1));

  const lines = [];
  let held = usage.length ? 0 : distributable; // with no usage at all, everything is held

  usage.forEach((event, index) => {
    const value = usageValues[index];
    const splits = splitsByWork[event.work_id] || [];

    if (!splitsAreComplete(splits)) {
      // Money for this play is held until the splits are confirmed.
      lines.push({ holderId: null, usageId: event.id, workId: event.work_id, sharePercent: null, usageValue: value, amount: value, status: 'held' });
      held += value;
      return;
    }

    const parts = allocate(value, splits.map((split) => Number(split.share_percent)));
    splits.forEach((split, i) => {
      lines.push({
        holderId: split.holder_id,
        usageId: event.id,
        workId: event.work_id,
        sharePercent: Number(split.share_percent),
        usageValue: value,
        amount: parts[i],
        status: 'pending'
      });
    });
  });

  return { pool, adminFeeRate: rate, adminFee, distributable, held, usageCount: usage.length, lines };
}

// Calculate AND save a draft run for a period. Returns the saved run.
async function createDraftRun(db, period, adminFeeRate, actor) {
  const existing = await db.prepare(
    "SELECT id FROM distribution_runs WHERE period = ? AND status <> 'cancelled'"
  ).get(period);
  if (existing) {
    throw new Error(`A distribution run already exists for ${period} (${existing.id}). Cancel it first to recalculate.`);
  }

  const inputs = await loadPeriodInputs(db, period);
  const result = calculate(inputs, adminFeeRate);
  const runId = newId('RUN');

  await db.prepare(`INSERT INTO distribution_runs (id, period, total_pool, admin_fee_rate, admin_fee, distributable, held_amount,
      usage_count, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(runId, period, result.pool, result.adminFeeRate, result.adminFee, result.distributable, result.held,
      result.usageCount, 'draft', actor ? actor.id : null, nowIso());

  for (const line of result.lines) {
    await db.prepare(`INSERT INTO royalty_lines (id, run_id, holder_id, usage_id, work_id, share_percent, usage_value, amount, paid_status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(newId('RL'), runId, line.holderId, line.usageId, line.workId, line.sharePercent, line.usageValue, line.amount, line.status);
  }

  return db.prepare('SELECT * FROM distribution_runs WHERE id = ?').get(runId);
}

module.exports = { MAX_ADMIN_FEE_RATE, allocate, splitsAreComplete, calculate, loadPeriodInputs, createDraftRun };
