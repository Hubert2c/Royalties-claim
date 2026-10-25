// =============================================================================
// lib/tariffs.js — work out the licence fee from a tariff
// -----------------------------------------------------------------------------
// Tariff "basis" values (Table 7 of the document):
//   flat_annual   — a yearly amount (radio, TV, venues). Shorter periods are
//                   charged pro-rata by month.
//   percent_gross — a percentage of declared gross receipts (concerts, telecoms,
//                   digital services).
//   per_ad        — an amount for each advertisement that uses music.
//   per_event     — an amount for each event.
// All results are whole Rwandan francs.
// =============================================================================

const BASES = ['flat_annual', 'percent_gross', 'per_ad', 'per_event'];
const CATEGORIES = ['radio', 'tv', 'event', 'advertiser', 'venue', 'telecom', 'digital'];

// Number of calendar months covered by a period, counting both ends.
// e.g. 2026-01-01 → 2026-12-31 = 12 months; 2026-03-15 → 2026-03-20 = 1 month.
function monthsCovered(periodStart, periodEnd) {
  const start = new Date(periodStart);
  const end = new Date(periodEnd);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return 0;
  return (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + (end.getUTCMonth() - start.getUTCMonth()) + 1;
}

// Returns { fee, explanation } or throws an Error with a user-friendly message.
function computeFee(tariff, { periodStart, periodEnd, quantity, grossAmount }) {
  const rate = Number(tariff.rate);

  switch (tariff.basis) {
    case 'flat_annual': {
      const months = monthsCovered(periodStart, periodEnd);
      if (months < 1) throw new Error('The licence period is not valid.');
      const fee = Math.round((rate * Math.min(months, 12)) / 12);
      return { fee, explanation: `Rwf ${rate.toLocaleString('en-US')} per year × ${Math.min(months, 12)}/12 months` };
    }
    case 'percent_gross': {
      const gross = Number(grossAmount);
      if (!Number.isFinite(gross) || gross <= 0) throw new Error('Declared gross receipts are required for this tariff.');
      return { fee: Math.round((gross * rate) / 100), explanation: `${rate}% of declared gross receipts (Rwf ${gross.toLocaleString('en-US')})` };
    }
    case 'per_ad':
    case 'per_event': {
      const count = Number(quantity);
      if (!Number.isInteger(count) || count < 1) throw new Error('Please give the number of adverts/events (a whole number of at least 1).');
      return { fee: Math.round(rate * count), explanation: `Rwf ${rate.toLocaleString('en-US')} × ${count}` };
    }
    default:
      throw new Error('Unknown tariff basis.');
  }
}

module.exports = { BASES, CATEGORIES, monthsCovered, computeFee };
