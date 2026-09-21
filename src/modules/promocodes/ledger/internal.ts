import type { Tx } from '../../../db/client.js';
import type { Balance, HoldInput, Ledger } from './types.js';

type EntryRow = { id: string; amount: string; kind: string };

/**
 * The ledger as a table in this database. One row per posting, append-only.
 * A hold's reference is the id of the row that created it, so every later
 * posting points back at exactly what it is settling.
 *
 * Valid for a deployment with no external ledger, and the implementation the
 * tests run against.
 */
export const internalLedger: Ledger = {
  name: 'internal',

  async hold(tx: Tx, input: HoldInput): Promise<{ holdRef: string }> {
    assertAmount(input.amount);

    const [row] = await tx<EntryRow[]>`
      insert into ledger_entries
        (tenant_id, redemption_id, party, currency, kind, amount, hold_ref)
      values (${input.tenantId}, ${input.redemptionId}, ${input.party}, ${input.currency},
              'hold', ${input.amount}, '')
      returning id, amount, kind
    `;
    if (!row) throw new Error('ledger: hold wrote no entry');

    // The hold is its own reference; it is only knowable after the insert.
    await tx`update ledger_entries set hold_ref = ${row.id} where id = ${row.id}`;
    return { holdRef: row.id };
  },

  async capture(tx, input): Promise<void> {
    assertAmount(input.amount);
    const hold = await holdFor(tx, input.tenantId, input.holdRef);

    if (input.amount > hold.amount) {
      throw new Error(
        `ledger: cannot capture ${input.amount} against a hold of ${hold.amount}`,
      );
    }

    // The partial unique index makes a second capture of the same hold fail
    // rather than double-count.
    await tx`
      insert into ledger_entries
        (tenant_id, redemption_id, party, currency, kind, amount, hold_ref)
      values (${input.tenantId}, ${input.redemptionId}, ${hold.party}, ${hold.currency},
              'capture', ${input.amount}, ${input.holdRef})
    `;
  },

  async release(tx, input): Promise<void> {
    const hold = await holdFor(tx, input.tenantId, input.holdRef);
    const captured = await capturedAgainst(tx, input.holdRef);
    const amount = input.amount ?? hold.amount - captured;

    // Nothing left to let go of: a fully captured hold releases zero, and
    // writing a zero row would only be noise.
    if (amount <= 0) return;

    await tx`
      insert into ledger_entries
        (tenant_id, redemption_id, party, currency, kind, amount, hold_ref)
      values (${input.tenantId}, ${input.redemptionId}, ${hold.party}, ${hold.currency},
              'release', ${amount}, ${input.holdRef})
    `;
  },

  async balance(tx, input): Promise<Balance> {
    const rows = await tx<{ kind: string; total: string }[]>`
      select kind, coalesce(sum(amount), 0)::text as total
      from ledger_entries
      where tenant_id = ${input.tenantId}
        and party = ${input.party}
        and currency = ${input.currency}
      group by kind
    `;

    const by = (kind: string) => Number(rows.find((r) => r.kind === kind)?.total ?? 0);
    return { held: by('hold'), captured: by('capture'), released: by('release') };
  },
};

async function holdFor(
  tx: Tx,
  tenantId: string,
  holdRef: string,
): Promise<{ amount: number; party: string; currency: string }> {
  const [row] = await tx<{ amount: string; party: string; currency: string }[]>`
    select amount::text, party, currency from ledger_entries
    where id = ${holdRef} and tenant_id = ${tenantId} and kind = 'hold'
  `;
  if (!row) throw new Error(`ledger: no hold ${holdRef}`);
  return { amount: Number(row.amount), party: row.party, currency: row.currency };
}

async function capturedAgainst(tx: Tx, holdRef: string): Promise<number> {
  const [row] = await tx<{ total: string }[]>`
    select coalesce(sum(amount), 0)::text as total from ledger_entries
    where hold_ref = ${holdRef} and kind = 'capture'
  `;
  return Number(row?.total ?? 0);
}

function assertAmount(amount: number): void {
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new Error(`ledger: ${amount} is not a whole amount in minor units`);
  }
}
