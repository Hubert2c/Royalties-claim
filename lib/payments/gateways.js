// =============================================================================
// lib/payments/gateways.js — how money comes in (licence fees) and goes out
// (royalty payouts)
// -----------------------------------------------------------------------------
// Royalty Hub never holds money. It asks a licensed payment provider to move
// it and stores the provider's reference (see "How payments work" in the
// presentation document).
//
// Design (Template Method + Factory patterns):
//
//   PaymentGateway (abstract base class)
//     collect() / payout()  — the same steps for every provider:
//         1. validate the request            (validatePayer: overridden per channel)
//         2. simulated mode -> make a SIM reference
//            live mode      -> liveCollect() / livePayout() (provider specific)
//     ├── MobileMoneyGateway   (MTN MoMo / Airtel Money; payer must be 07XXXXXXXX)
//     ├── BankTransferGateway  (bank transfer)
//     └── IremboGateway        (government payment portal)
//
//   PaymentGatewayFactory.create('momo') -> the right subclass.
//
// The prototype runs in SIMULATED mode (PAYMENTS_MODE is not "live"). The live
// methods are the extension points for the pilot phase: each provider's API
// is connected there once RIPO signs the agreements. Until then they refuse
// with a clear NotConfiguredError instead of pretending to work.
// =============================================================================

const crypto = require('crypto');
const { ValidationError, NotConfiguredError } = require('../errors');

const hex = (bytes) => crypto.randomBytes(bytes).toString('hex').toUpperCase();

class PaymentGateway {
  /**
   * @param {string} channel - short code stored with each payment (momo, bank, irembo)
   * @param {object} [options]
   * @param {'simulated'|'live'} [options.mode='simulated']
   */
  constructor(channel, { mode = 'simulated' } = {}) {
    if (new.target === PaymentGateway) throw new TypeError('PaymentGateway is abstract; use a subclass.');
    this.channel = channel;
    this.mode = mode;
  }

  /** Name shown to users, e.g. "Mobile money". Subclasses override it. */
  get displayName() { return this.channel; }

  get isSimulated() { return this.mode !== 'live'; }

  /** Check who is paying. The default accepts anyone; subclasses add rules. */
  validatePayer(payer) { return payer; }

  /**
   * Take a payment from a music user (a licence fee).
   * @returns {Promise<{reference: string, simulated: boolean}>}
   */
  async collect({ amount, payer }) {
    if (!(Number(amount) > 0)) throw new ValidationError('The amount to collect must be more than zero.');
    this.validatePayer(payer);
    if (this.isSimulated) return { reference: `${this.channel.toUpperCase()}-SIM-${hex(3)}`, simulated: true };
    return this.liveCollect({ amount, payer });
  }

  /**
   * Send royalties to a rights holder.
   * @returns {Promise<{reference: string, simulated: boolean}>}
   */
  async payout({ amount, holderId, runId }) {
    if (!(Number(amount) >= 0)) throw new ValidationError('The payout amount is not valid.');
    if (this.isSimulated) return { reference: `${this.channel.toUpperCase()}-SIM-${String(runId).slice(-4)}-${hex(2)}`, simulated: true };
    return this.livePayout({ amount, holderId, runId });
  }

  // --- extension points for the live providers (pilot phase) ----------------
  async liveCollect() { throw new NotConfiguredError(`${this.displayName} collections are not connected yet (pilot phase).`); }

  async livePayout() { throw new NotConfiguredError(`${this.displayName} payouts are not connected yet (pilot phase).`); }
}

class MobileMoneyGateway extends PaymentGateway {
  constructor(options) { super('momo', options); }

  get displayName() { return 'Mobile money'; }

  /** Rwandan mobile money numbers look like 07XXXXXXXX. */
  validatePayer(payer) {
    const number = String(payer || '').replace(/\s+/g, '');
    if (!/^07\d{8}$/.test(number)) {
      throw new ValidationError('Enter the mobile money number that will pay (e.g. 0788123456).');
    }
    return number;
  }
}

class BankTransferGateway extends PaymentGateway {
  constructor(options) { super('bank', options); }

  get displayName() { return 'Bank account'; }
}

class IremboGateway extends PaymentGateway {
  constructor(options) { super('irembo', options); }

  get displayName() { return 'Irembo'; }
}

class PaymentGatewayFactory {
  static CHANNELS = { momo: MobileMoneyGateway, bank: BankTransferGateway, irembo: IremboGateway };

  /**
   * @param {string} channel - momo | bank | irembo (anything else falls back to momo)
   * @param {object} [options] - { mode }; defaults to PAYMENTS_MODE or "simulated"
   */
  static create(channel, options = { mode: process.env.PAYMENTS_MODE === 'live' ? 'live' : 'simulated' }) {
    const GatewayClass = PaymentGatewayFactory.CHANNELS[channel] || MobileMoneyGateway;
    return new GatewayClass(options);
  }

  static isKnownChannel(channel) {
    return Object.prototype.hasOwnProperty.call(PaymentGatewayFactory.CHANNELS, channel);
  }
}

module.exports = { PaymentGateway, MobileMoneyGateway, BankTransferGateway, IremboGateway, PaymentGatewayFactory };
