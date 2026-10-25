// =============================================================================
// lib/util/format.js — small formatting helpers shared by several services
// =============================================================================

/** Whole Rwandan francs for messages, e.g. rwf(150000) -> "Rwf 150,000". */
const rwf = (amount) => `Rwf ${Math.round(Number(amount || 0)).toLocaleString('en-US')}`;

/** Is the value a month in the form YYYY-MM? */
const isPeriod = (value) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(value || ''));

/** The current month as YYYY-MM (UTC). */
const currentPeriod = () => new Date().toISOString().slice(0, 7);

module.exports = { rwf, isPeriod, currentPeriod };
