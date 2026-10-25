// =============================================================================
// lib/licensing/LicensingService.js — the life of a licence (FR-3, FR-7)
// -----------------------------------------------------------------------------
//   applied  --approve-->  invoiced (clearance code issued)  --pay-->  paid
//      \--reject--> rejected
//
// The fee comes from an approved tariff (TariffRuleFactory), and the payment
// goes through a PaymentGateway. The clearance code is what a broadcaster,
// permit office or venue checks before an advert airs or an event goes ahead.
// =============================================================================

const crypto = require('crypto');
const { TariffRuleFactory } = require('../tariffs/TariffRules');
const { PaymentGatewayFactory } = require('../payments/gateways');
const { ValidationError, NotFoundError, ConflictError } = require('../errors');

class LicensingService {
  /**
   * @param {object} deps
   * @param {object} deps.db
   * @param {Function} deps.newId
   * @param {Function} deps.nowIso
   * @param {typeof PaymentGatewayFactory} [deps.gateways]
   */
  constructor({ db, newId, nowIso, gateways = PaymentGatewayFactory }) {
    this.db = db;
    this.newId = newId;
    this.nowIso = nowIso;
    this.gateways = gateways;
  }

  /** A random, hard-to-guess code such as "CLR-1A2B3C4D". */
  static newClearanceCode() {
    return `CLR-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
  }

  /**
   * A music user applies for a licence. The fee is calculated from the tariff.
   * @returns {Promise<{licenceId: string, tariff: object, fee: number, explanation: string}>}
   */
  async apply(licenseeId, { tariffId, periodStart, periodEnd, quantity, grossAmount, description }) {
    const tariff = await this.db.prepare("SELECT * FROM tariffs WHERE id = ? AND status = 'approved'").get(tariffId);
    if (!tariff) throw new ValidationError('Please choose an approved tariff.');
    if (!periodStart || !periodEnd || new Date(periodEnd) < new Date(periodStart)) {
      throw new ValidationError('Please give a valid licence period (the end date must be after the start date).');
    }

    const { fee, explanation } = TariffRuleFactory.computeFee(tariff, {
      periodStart, periodEnd, quantity: Number(quantity), grossAmount: Number(grossAmount)
    });

    const licenceId = this.newId('LCN');
    await this.db.prepare(`INSERT INTO licences (id, licensee_id, tariff_id, period_start, period_end, quantity, gross_amount, fee_due,
        status, clearance_code, description, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(licenceId, licenseeId, tariff.id, periodStart, periodEnd,
        Number.isInteger(Number(quantity)) && Number(quantity) > 0 ? Number(quantity) : null,
        Number(grossAmount) > 0 ? Math.round(Number(grossAmount)) : null,
        fee, 'applied', null, description ? String(description).slice(0, 300) : null, this.nowIso());
    return { licenceId, tariff, fee, explanation };
  }

  /** Load a licence or throw NotFoundError. */
  async get(licenceId) {
    const licence = await this.db.prepare('SELECT * FROM licences WHERE id = ?').get(licenceId);
    if (!licence) throw new NotFoundError('Licence');
    return licence;
  }

  /**
   * The administrator approves (invoice + clearance code) or rejects an application.
   * @param {'approve'|'reject'} decision
   * @returns {Promise<{licence: object, code: string|null}>}
   */
  async decide(licenceId, decision) {
    if (!['approve', 'reject'].includes(decision)) throw new NotFoundError('Action');
    const licence = await this.get(licenceId);
    if (licence.status !== 'applied') throw new ConflictError(`This licence is already ${licence.status}.`);

    if (decision === 'approve') {
      const code = LicensingService.newClearanceCode();
      await this.db.prepare("UPDATE licences SET status = 'invoiced', clearance_code = ? WHERE id = ?").run(code, licence.id);
      return { licence, code };
    }
    await this.db.prepare("UPDATE licences SET status = 'rejected' WHERE id = ?").run(licence.id);
    return { licence, code: null };
  }

  /**
   * The music user pays its invoice through the chosen channel's gateway.
   * @returns {Promise<{licence: object, paymentId: string, channel: string, reference: string, simulated: boolean}>}
   */
  async pay(licenceId, licenseeId, { channel: requested, payer }) {
    const licence = await this.db.prepare('SELECT * FROM licences WHERE id = ? AND licensee_id = ?').get(licenceId, licenseeId);
    if (!licence) throw new NotFoundError('Licence');
    if (licence.status !== 'invoiced') {
      throw new ConflictError(licence.status === 'paid' ? 'This licence is already paid.' : 'This licence has not been approved and invoiced yet.');
    }

    // Polymorphism: each channel's gateway validates the payer in its own way.
    const channel = this.gateways.isKnownChannel(requested) ? requested : 'momo';
    const { reference, simulated } = await this.gateways.create(channel).collect({ amount: licence.fee_due, payer });

    const paymentId = this.newId('PAY');
    await this.db.prepare('INSERT INTO payments (id, licence_id, amount, channel, reference, paid_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(paymentId, licence.id, licence.fee_due, channel, reference, this.nowIso());
    await this.db.prepare("UPDATE licences SET status = 'paid' WHERE id = ?").run(licence.id);
    return { licence, paymentId, channel, reference, simulated };
  }
}

module.exports = { LicensingService };
