// =============================================================================
// lib/royalties/DistributionService.js — the life of a monthly distribution run
// -----------------------------------------------------------------------------
//   draft  --approve-->  approved  --pay-->  paid
//     \--cancel--> cancelled
//
// The service reads and writes the database; the maths itself is delegated to
// RoyaltyEngine, and the money movement to a PaymentGateway. Each collaborator
// is passed in through the constructor (dependency injection), so tests can
// replace any of them.
// =============================================================================

const { RoyaltyEngine } = require('./RoyaltyEngine');
const { ConflictError, NotFoundError } = require('../errors');
const { PaymentGatewayFactory } = require('../payments/gateways');
const { rwf } = require('../util/format');

class DistributionService {
  /**
   * @param {object} deps
   * @param {object} deps.db - the database wrapper from database.js
   * @param {RoyaltyEngine} [deps.engine]
   * @param {Function} deps.newId - creates IDs such as "RUN-1A2B3C4D"
   * @param {Function} deps.nowIso - current time as an ISO string
   * @param {object} [deps.notifications] - NotificationService (optional)
   * @param {typeof PaymentGatewayFactory} [deps.gateways]
   */
  constructor({ db, engine = new RoyaltyEngine(), newId, nowIso, notifications = null, gateways = PaymentGatewayFactory }) {
    this.db = db;
    this.engine = engine;
    this.newId = newId;
    this.nowIso = nowIso;
    this.notifications = notifications;
    this.gateways = gateways;
  }

  /** Read everything the engine needs for one period (no writes). */
  async loadPeriodInputs(period) {
    const poolRow = await this.db.prepare(
      'SELECT COALESCE(SUM(amount), 0) AS total FROM payments WHERE substr(paid_at, 1, 7) = ?'
    ).get(period);

    const usage = await this.db.prepare(`
      SELECT u.id, u.recording_id, r.work_id
      FROM usage_events u
      JOIN recordings r ON r.id = u.recording_id
      WHERE u.period = ? AND u.status = 'matched'
      ORDER BY u.played_at ASC, u.id ASC
    `).all(period);

    const splitRows = await this.db.prepare(`
      SELECT s.work_id, s.holder_id, s.share_percent, s.status
      FROM splits s WHERE s.status <> 'rejected' ORDER BY s.work_id, s.holder_id
    `).all();

    // Group shares by song for quick look-up (one pass, O(n)).
    const splitsByWork = {};
    for (const split of splitRows) {
      (splitsByWork[split.work_id] = splitsByWork[split.work_id] || []).push(split);
    }
    return { pool: Number(poolRow.total), usage, splitsByWork };
  }

  /** Calculate and save a DRAFT run. Nothing is paid yet. */
  async createDraftRun(period, adminFeeRate, actor) {
    const existing = await this.db.prepare(
      "SELECT id FROM distribution_runs WHERE period = ? AND status <> 'cancelled'"
    ).get(period);
    if (existing) {
      throw new ConflictError(`A distribution run already exists for ${period} (${existing.id}). Cancel it first to recalculate.`);
    }

    const result = this.engine.calculate(await this.loadPeriodInputs(period), adminFeeRate);
    const runId = this.newId('RUN');

    await this.db.prepare(`INSERT INTO distribution_runs (id, period, total_pool, admin_fee_rate, admin_fee, distributable, held_amount,
        usage_count, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(runId, period, result.pool, result.adminFeeRate, result.adminFee, result.distributable, result.held,
        result.usageCount, 'draft', actor ? actor.id : null, this.nowIso());

    for (const line of result.lines) {
      await this.db.prepare(`INSERT INTO royalty_lines (id, run_id, holder_id, usage_id, work_id, share_percent, usage_value, amount, paid_status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(this.newId('RL'), runId, line.holderId, line.usageId, line.workId, line.sharePercent, line.usageValue, line.amount, line.status);
    }
    return this.getRun(runId);
  }

  async getRun(runId) {
    const run = await this.db.prepare('SELECT * FROM distribution_runs WHERE id = ?').get(runId);
    if (!run) throw new NotFoundError('Run');
    return run;
  }

  /** Approve a draft run and tell each rights holder what they will receive. */
  async approveRun(runId, actor) {
    const result = await this.db.prepare(
      "UPDATE distribution_runs SET status = 'approved', approved_by = ?, approved_at = ? WHERE id = ? AND status = 'draft'"
    ).run(actor.id, this.nowIso(), runId);
    if (!result.changes) throw new ConflictError('Only a draft run can be approved.');

    if (this.notifications) {
      const totals = await this.db.prepare(`SELECT rl.holder_id, SUM(rl.amount) AS amount, r.period
        FROM royalty_lines rl JOIN distribution_runs r ON r.id = rl.run_id
        WHERE rl.run_id = ? AND rl.holder_id IS NOT NULL GROUP BY rl.holder_id, r.period`).all(runId);
      for (const total of totals) {
        await this.notifications.notifyHolders(total.holder_id,
          `Royalties for ${total.period} approved: ${rwf(total.amount)}`,
          'Your statement is ready. Payment follows shortly.', 'statements');
      }
    }
  }

  /** Cancel a draft run so the period can be recalculated. */
  async cancelRun(runId) {
    const result = await this.db.prepare(
      "UPDATE distribution_runs SET status = 'cancelled' WHERE id = ? AND status = 'draft'"
    ).run(runId);
    if (!result.changes) throw new ConflictError('Only a draft run can be cancelled.');
  }

  /**
   * Pay an approved run: one payout per rights holder through the gateway for
   * their payout method (mobile money or bank). Holders without payout details
   * stay pending.
   * @returns {{paidHolders: number, skipped: number, simulated: boolean}}
   */
  async payRun(runId) {
    const run = await this.db.prepare('SELECT * FROM distribution_runs WHERE id = ?').get(runId);
    if (!run || run.status !== 'approved') throw new ConflictError('Only an approved run can be paid.');

    const holders = await this.db.prepare(`SELECT DISTINCT h.id, h.payout_ref_last4, h.payout_method FROM royalty_lines rl
      JOIN rights_holders h ON h.id = rl.holder_id WHERE rl.run_id = ? AND rl.paid_status = 'pending'`).all(run.id);

    let paidHolders = 0;
    let skipped = 0;
    let simulated = true;
    for (const holder of holders) {
      if (!holder.payout_ref_last4) { skipped += 1; continue; } // no payout details yet

      const due = await this.db.prepare(
        "SELECT COALESCE(SUM(amount), 0) AS amount FROM royalty_lines WHERE run_id = ? AND holder_id = ? AND paid_status = 'pending'"
      ).get(run.id, holder.id);

      // Polymorphism: the right gateway class is chosen from the payout method.
      const gateway = this.gateways.create(holder.payout_method === 'bank' ? 'bank' : 'momo');
      const receipt = await gateway.payout({ amount: Number(due.amount), holderId: holder.id, runId: run.id });
      simulated = simulated && receipt.simulated;

      await this.db.prepare("UPDATE royalty_lines SET paid_status = 'paid', payout_reference = ? WHERE run_id = ? AND holder_id = ? AND paid_status = 'pending'")
        .run(receipt.reference, run.id, holder.id);
      if (this.notifications) {
        await this.notifications.notifyHolders(holder.id,
          `${rwf(due.amount)} sent to your ${gateway.displayName.toLowerCase()}`,
          `Royalties for ${run.period}. Reference ${receipt.reference}.`, 'statements');
      }
      paidHolders += 1;
    }

    const stillPending = Number((await this.db.prepare(
      "SELECT COUNT(*) AS n FROM royalty_lines WHERE run_id = ? AND paid_status = 'pending'"
    ).get(run.id)).n);
    if (stillPending === 0) {
      await this.db.prepare("UPDATE distribution_runs SET status = 'paid', paid_at = ? WHERE id = ?").run(this.nowIso(), run.id);
    }
    return { paidHolders, skipped, simulated };
  }
}

module.exports = { DistributionService };
