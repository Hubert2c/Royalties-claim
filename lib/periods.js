// =============================================================================
// lib/periods.js — helpers for monthly charts
// =============================================================================

// The last `count` months as "YYYY-MM", oldest first, ending with this month.
function lastMonths(count = 12, from = new Date()) {
  const months = [];
  const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
  for (let i = 0; i < count; i += 1) {
    months.unshift(cursor.toISOString().slice(0, 7));
    cursor.setUTCMonth(cursor.getUTCMonth() - 1);
  }
  return months;
}

// Turn rows like [{ period: '2026-10', value: 5 }] into one value per month (0 when missing).
function fillMonths(months, rows) {
  const byMonth = {};
  rows.forEach((row) => { byMonth[row.period] = Number(row.value || 0); });
  return months.map((month) => byMonth[month] || 0);
}

module.exports = { lastMonths, fillMonths };
