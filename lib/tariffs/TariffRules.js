// =============================================================================
// lib/tariffs/TariffRules.js — work out a licence fee from an approved tariff
// -----------------------------------------------------------------------------
// Every tariff has a "basis" (Table 7 of the document). Each basis is a class
// with the same method, computeFee(request) -> { fee, explanation }:
//
//   FlatAnnualRule    flat_annual    a yearly amount (radio, TV, venues),
//                                    shorter periods charged by the month
//   PercentGrossRule  percent_gross  a % of declared gross receipts
//                                    (concerts, telecoms, digital services)
//   PerUnitRule       per_ad         an amount per advert
//                     per_event      an amount per event
//
// TariffRuleFactory.forTariff(tariff) picks the class, so code that issues
// licences never needs a switch statement on the basis (polymorphism).
// All fees are whole Rwandan francs.
// =============================================================================

const { ValidationError } = require('../errors');

const BASES = ['flat_annual', 'percent_gross', 'per_ad', 'per_event'];
const CATEGORIES = ['radio', 'tv', 'event', 'advertiser', 'venue', 'telecom', 'digital'];

const formatRwf = (value) => `Rwf ${Number(value).toLocaleString('en-US')}`;

class TariffRule {
  /** @param {{rate: number}} tariff - the approved tariff row */
  constructor(tariff) {
    if (new.target === TariffRule) throw new TypeError('TariffRule is abstract; use a subclass.');
    this.rate = Number(tariff.rate);
  }

  /**
   * @param {{periodStart?: string, periodEnd?: string, quantity?: number, grossAmount?: number}} request
   * @returns {{fee: number, explanation: string}}
   */
  computeFee(request) { throw new Error(`${this.constructor.name} must implement computeFee(${typeof request}).`); }

  /**
   * Calendar months covered by a period, counting both ends.
   * 2026-01-01 → 2026-12-31 = 12; 2026-03-15 → 2026-03-20 = 1.
   */
  static monthsCovered(periodStart, periodEnd) {
    const start = new Date(periodStart);
    const end = new Date(periodEnd);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return 0;
    return (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + (end.getUTCMonth() - start.getUTCMonth()) + 1;
  }
}

class FlatAnnualRule extends TariffRule {
  computeFee({ periodStart, periodEnd }) {
    const months = TariffRule.monthsCovered(periodStart, periodEnd);
    if (months < 1) throw new ValidationError('The licence period is not valid.');
    const charged = Math.min(months, 12);
    return { fee: Math.round((this.rate * charged) / 12), explanation: `${formatRwf(this.rate)} per year × ${charged}/12 months` };
  }
}

class PercentGrossRule extends TariffRule {
  computeFee({ grossAmount }) {
    const gross = Number(grossAmount);
    if (!Number.isFinite(gross) || gross <= 0) throw new ValidationError('Declared gross receipts are required for this tariff.');
    return { fee: Math.round((gross * this.rate) / 100), explanation: `${this.rate}% of declared gross receipts (${formatRwf(gross)})` };
  }
}

class PerUnitRule extends TariffRule {
  computeFee({ quantity }) {
    const count = Number(quantity);
    if (!Number.isInteger(count) || count < 1) {
      throw new ValidationError('Please give the number of adverts/events (a whole number of at least 1).');
    }
    return { fee: Math.round(this.rate * count), explanation: `${formatRwf(this.rate)} × ${count}` };
  }
}

class TariffRuleFactory {
  static RULES = { flat_annual: FlatAnnualRule, percent_gross: PercentGrossRule, per_ad: PerUnitRule, per_event: PerUnitRule };

  /** @returns {TariffRule} */
  static forTariff(tariff) {
    const Rule = TariffRuleFactory.RULES[tariff.basis];
    if (!Rule) throw new ValidationError('Unknown tariff basis.');
    return new Rule(tariff);
  }

  /** Shortcut: the fee for one tariff and one licence request. */
  static computeFee(tariff, request) {
    return TariffRuleFactory.forTariff(tariff).computeFee(request);
  }
}

module.exports = { BASES, CATEGORIES, TariffRule, FlatAnnualRule, PercentGrossRule, PerUnitRule, TariffRuleFactory };
