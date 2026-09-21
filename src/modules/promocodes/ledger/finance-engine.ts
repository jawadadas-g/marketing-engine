import type { Ledger } from './types.js';

/**
 * The finance engine as the ledger. NOT IMPLEMENTED: there is no endpoint yet,
 * so every call fails loudly rather than pretending to have recorded money.
 *
 * When the endpoints exist, this adapter makes four calls, all plain `fetch`
 * against `FINANCE_ENGINE_URL`:
 *
 *   hold     POST /holds          { tenantId, redemptionId, party, currency, amount }
 *                                 → { holdRef }
 *   capture  POST /holds/:ref/capture   { amount }        → 204
 *   release  POST /holds/:ref/release   {}                → 204
 *   balance  GET  /balances?party=&currency=              → { held, captured, released }
 *
 * The contract it must honour is the same one `internal` honours: a hold is
 * captured at most once and released at most once, a capture is never larger
 * than its hold, and amounts are integers in the currency's minor unit.
 */
function notConfigured(): never {
  throw new Error(
    'ledger: the finance-engine ledger is not configured (no FINANCE_ENGINE_URL, and no client yet)',
  );
}

export const financeEngineLedger: Ledger = {
  name: 'finance-engine',
  async hold() {
    return notConfigured();
  },
  async capture() {
    return notConfigured();
  },
  async release() {
    return notConfigured();
  },
  async balance() {
    return notConfigured();
  },
};
