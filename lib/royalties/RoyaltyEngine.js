// =============================================================================
// lib/royalties/RoyaltyEngine.js — the pure royalty calculation (no database)
// -----------------------------------------------------------------------------
// Implements the flowchart in Figure 7 and requirement FR-6 of the document:
//
//   1. POOL          = all licence payments received during the period.
//   2. ADMIN FEE     = POOL × admin fee rate, never more than 30% (the 70/30 rule).
//   3. DISTRIBUTABLE = POOL − ADMIN FEE.
//   4. Every MATCHED play in the period gets an equal part of DISTRIBUTABLE
//      (one play = one unit).
//   5. Each play's value is split between the rights holders of the song by
//      their CONFIRMED shares. If the shares are not all confirmed (or do not
//      total 100%), the money is HELD — recorded, but not paid.
//
// The class has no database access: it takes plain data and returns plain data.
// That makes it easy to test (see tests/unit.test.js) and to reuse.
// =============================================================================

const { MoneyAllocator } = require('../money/MoneyAllocator');

class RoyaltyEngine {
  /** The legal maximum administration fee proposed in the document (30%). */
  static MAX_ADMIN_FEE_RATE = 0.30;

  /**
   * @param {object} [options]
   * @param {number} [options.maxAdminFeeRate=0.30] - upper limit for the admin fee
   */
  constructor({ maxAdminFeeRate = RoyaltyEngine.MAX_ADMIN_FEE_RATE } = {}) {
    this.maxAdminFeeRate = maxAdminFeeRate;
  }

  /** Keep the admin fee rate between 0 and the legal maximum. */
  clampRate(rate) {
    return Math.min(Math.max(Number(rate) || 0, 0), this.maxAdminFeeRate);
  }

  /**
   * Are the shares of a song complete? All confirmed and adding up to 100%.
   * @param {{status: string, share_percent: number}[]} splits
   */
  static splitsAreComplete(splits) {
    if (!splits.length) return false;
    const allConfirmed = splits.every((split) => split.status === 'confirmed');
    const total = splits.reduce((sum, split) => sum + Number(split.share_percent), 0);
    return allConfirmed && Math.abs(total - 100) < 0.001;
  }

  /**
   * Calculate a distribution.
   * @param {object} inputs
   * @param {number} inputs.pool - money collected in the period (whole Rwf)
   * @param {{id: string, work_id: string}[]} inputs.usage - matched plays
   * @param {Object<string, object[]>} inputs.splitsByWork - shares per song
   * @param {number} adminFeeRate - e.g. 0.15 for 15%
   * @returns {{pool, adminFeeRate, adminFee, distributable, held, usageCount, lines}}
   */
  calculate({ pool, usage, splitsByWork }, adminFeeRate) {
    const rate = this.clampRate(adminFeeRate);
    const adminFee = Math.round(pool * rate);
    const distributable = pool - adminFee;

    // Equal value per play, in whole francs that add up to `distributable`.
    const usageValues = MoneyAllocator.allocate(distributable, usage.map(() => 1));

    const lines = [];
    let held = usage.length ? 0 : distributable; // no plays at all: everything is held

    usage.forEach((event, index) => {
      const value = usageValues[index];
      const splits = splitsByWork[event.work_id] || [];

      if (!RoyaltyEngine.splitsAreComplete(splits)) {
        lines.push(RoyaltyEngine.heldLine(event, value));
        held += value;
        return;
      }

      const parts = MoneyAllocator.allocate(value, splits.map((split) => Number(split.share_percent)));
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

  /** A line that keeps the money of a play aside until the song's shares are confirmed. */
  static heldLine(event, value) {
    return { holderId: null, usageId: event.id, workId: event.work_id, sharePercent: null, usageValue: value, amount: value, status: 'held' };
  }
}

module.exports = { RoyaltyEngine };
