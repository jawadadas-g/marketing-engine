import type { Tx } from '../../../db/client.js';

/** Who pays for a discount: 'platform' or 'tenant:<uuid>'. */
export type Party = string;

export type HoldInput = {
  tenantId: string;
  redemptionId: string;
  party: Party;
  currency: string;
  /** Minor units, always a positive integer. */
  amount: number;
};

export type Balance = { held: number; captured: number; released: number };

/**
 * Where the money side of a promocode lives. The engine never moves money: it
 * records who owes what, and settlement between parties is somebody else's job.
 *
 * Every amount is an integer in the currency's minor unit.
 */
export interface Ledger {
  readonly name: string;
  hold(tx: Tx, input: HoldInput): Promise<{ holdRef: string }>;
  /** `amount` may be less than the hold (a partial order), never more. */
  capture(
    tx: Tx,
    input: { tenantId: string; redemptionId: string; holdRef: string; amount: number },
  ): Promise<void>;
  release(
    tx: Tx,
    input: { tenantId: string; redemptionId: string; holdRef: string; amount?: number },
  ): Promise<void>;
  balance(
    tx: Tx,
    input: { tenantId: string; party: Party; currency: string },
  ): Promise<Balance>;
}
