// =============================================================================
// lib/money/MoneyAllocator.js — split money into whole francs that add up exactly
// -----------------------------------------------------------------------------
// Algorithm: the LARGEST-REMAINDER method (also called Hamilton's method).
//
//   1. Work out everyone's exact share (it may have decimals).
//   2. Give everyone the whole-number part of their share.
//   3. A few francs are left over because of step 2. Give them out one at a
//      time, starting with the person whose decimal part was largest.
//
// Example: split 100 Rwf between 3 equal shares
//   exact shares = 33.33, 33.33, 33.33 -> whole parts 33, 33, 33 (99 in total)
//   1 franc is left -> it goes to the first share -> [34, 33, 33]
//
// Why: royalties are paid in whole Rwandan francs, and the sum of all lines must
// be EXACTLY the money available — never one franc more or less.
// Complexity: O(n log n) because of the sort in step 3 (n = number of shares).
// =============================================================================

class MoneyAllocator {
  /**
   * Split `total` whole francs in proportion to `weights`.
   * @param {number} total    - whole francs to share out (0 or more)
   * @param {number[]} weights - e.g. share percentages [70, 30] or plays [1, 1, 1]
   * @returns {number[]} whole francs per weight, same order, summing to `total`
   */
  static allocate(total, weights) {
    const sumWeights = weights.reduce((sum, weight) => sum + weight, 0);
    if (total <= 0 || sumWeights <= 0) return weights.map(() => 0);

    // Step 1 and 2: exact shares, then their whole-number parts.
    const exact = weights.map((weight) => (total * weight) / sumWeights);
    const result = exact.map((value) => Math.floor(value));
    let leftover = total - result.reduce((sum, value) => sum + value, 0);

    // Step 3: leftover francs go to the largest decimal parts first.
    // Ties are broken by position, so the same input always gives the same output.
    const order = exact
      .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
      .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
    for (let i = 0; leftover > 0; i += 1, leftover -= 1) {
      result[order[i % order.length].index] += 1;
    }
    return result;
  }
}

module.exports = { MoneyAllocator };
