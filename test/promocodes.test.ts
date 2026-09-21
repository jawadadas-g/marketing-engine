import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/api/app.js';
import { db, withTenant } from '../src/db/client.js';
import {
  expireReservations,
  internalLedger,
  reconcile,
  reserve,
  type Reconciliation,
} from '../src/modules/promocodes/index.js';
import { TENANT_A, TENANT_B, resetDb, startQueue, teardownDb, tokenFor } from './helpers.js';

const app = createApp();

let tokenA: string;
let tokenB: string;

function request(path: string, init: RequestInit = {}, token: string | null = tokenA) {
  return app.fetch(
    new Request(`http://engine.test${path}`, {
      ...init,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init.headers ?? {}),
      },
    }),
  );
}

const json = (body: unknown) => ({
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const cart = (subtotal: number, currency = 'SAR') => ({
  currency,
  subtotal,
  items: [{ sku: 'x', qty: 1, unitPrice: subtotal }],
});

const SPLIT_60_40 = [
  { party: 'platform', share: 0.6 },
  { party: `tenant:${TENANT_A}`, share: 0.4 },
];

type Promocode = { id: string; code: string };
type Redemption = {
  id: string;
  status: string;
  discount_amount: string;
  holds: { party: string; holdRef: string; amount: number }[];
};

async function createCode(overrides: Record<string, unknown> = {}): Promise<Promocode> {
  const res = await request('/v1/promocodes', {
    method: 'POST',
    ...json({
      code: 'SAVE10',
      currency: 'SAR',
      discount: { type: 'percent', value: 1000, maxDiscount: 5000 },
      funders: SPLIT_60_40,
      ...overrides,
    }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { promocode: Promocode }).promocode;
}

type ValidateResponse = { valid: boolean; reason?: string; discountAmount?: number };

async function validateCode(
  subtotal: number,
  extra: Record<string, unknown> = {},
): Promise<ValidateResponse> {
  const res = await request('/v1/promocodes/validate', {
    method: 'POST',
    ...json({ code: 'SAVE10', buyerRef: 'buyer-1', cart: cart(subtotal), ...extra }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as ValidateResponse;
}

async function reserveOrder(
  orderRef: string,
  subtotal = 80000,
  extra: Record<string, unknown> = {},
): Promise<{ status: number; body: { redemption?: Redemption; reason?: string } }> {
  const res = await request('/v1/redemptions', {
    method: 'POST',
    ...json({ code: 'SAVE10', buyerRef: 'buyer-1', cart: cart(subtotal), orderRef, ...extra }),
  });
  return { status: res.status, body: (await res.json()) as never };
}

async function entries(kind?: string) {
  return withTenant(
    TENANT_A,
    (tx) => tx<{ kind: string; amount: string; party: string; hold_ref: string }[]>`
      select kind, amount::text, party, hold_ref from ledger_entries
      ${kind ? tx`where kind = ${kind}` : tx``}
      order by id
    `,
  );
}

async function reconciliation(): Promise<Reconciliation> {
  const result = await withTenant(TENANT_A, (tx) => reconcile(tx, TENANT_A));
  return result.find((r) => r.currency === 'SAR')!;
}

beforeAll(async () => {
  await resetDb();
  await startQueue();
  tokenA = await tokenFor(TENANT_A);
  tokenB = await tokenFor(TENANT_B);
});

afterAll(async () => {
  process.env.LEDGER = 'internal';
  await teardownDb();
});

beforeEach(async () => {
  await resetDb();
  process.env.LEDGER = 'internal';
});

describe('validate', () => {
  it('computes a capped percentage and refuses below the minimum', async () => {
    await createCode();
    expect(await validateCode(80000)).toMatchObject({ valid: true, discountAmount: 5000 });
    expect(await validateCode(30000)).toMatchObject({ valid: true, discountAmount: 3000 });

    await db()`delete from promocodes`;
    await createCode({
      discount: { type: 'percent', value: 1000, maxDiscount: 5000, minSubtotal: 50000 },
    });
    expect(await validateCode(30000)).toMatchObject({ valid: false, reason: 'min_subtotal' });
  });

  it('refuses a cart in another currency', async () => {
    await createCode();
    const res = await request('/v1/promocodes/validate', {
      method: 'POST',
      ...json({ code: 'SAVE10', buyerRef: 'buyer-1', cart: cart(80000, 'USD') }),
    });
    expect(await res.json()).toMatchObject({ valid: false, reason: 'currency_mismatch' });
  });
});

describe('reserve, settle, release', () => {
  it('holds each funder share and reconciles', async () => {
    await createCode();
    const { status, body } = await reserveOrder('order-1');
    expect(status).toBe(201);
    expect(body.redemption!.status).toBe('reserved');

    const holds = await entries('hold');
    expect(holds.map((h) => Number(h.amount))).toEqual([3000, 2000]);
    expect(holds.map((h) => h.party)).toEqual(['platform', `tenant:${TENANT_A}`]);

    const events = await withTenant(
      TENANT_A,
      (tx) => tx`select id from events where type = 'promo.reserved'`,
    );
    expect(events).toHaveLength(1);

    const check = await reconciliation();
    expect(check.outstanding).toMatchObject({ redemptions: 5000, ledger: 5000, agrees: true });
    expect(check.settled).toMatchObject({ redemptions: 0, ledger: 0, agrees: true });
  });

  it('captures the whole discount on a full settle', async () => {
    await createCode();
    const { body } = await reserveOrder('order-1');

    const res = await request(`/v1/redemptions/${body.redemption!.id}/settle`, {
      method: 'POST',
      ...json({}),
    });
    expect(res.status).toBe(200);

    const captures = await entries('capture');
    expect(captures.map((c) => Number(c.amount))).toEqual([3000, 2000]);

    const check = await reconciliation();
    expect(check.settled).toMatchObject({ redemptions: 5000, ledger: 5000, agrees: true });
    expect(check.outstanding).toMatchObject({ redemptions: 0, ledger: 0, agrees: true });
  });

  it('releases every hold when the order goes away', async () => {
    await createCode();
    const { body } = await reserveOrder('order-1');

    const res = await request(`/v1/redemptions/${body.redemption!.id}/release`, {
      method: 'POST',
      ...json({ reason: 'cancelled' }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { redemption: Redemption }).redemption.status).toBe('released');

    const releases = await entries('release');
    expect(releases.map((r) => Number(r.amount))).toEqual([3000, 2000]);

    const check = await reconciliation();
    expect(check.outstanding).toMatchObject({ redemptions: 0, ledger: 0, agrees: true });
  });

  it('captures part and releases the rest on a partial settle', async () => {
    await createCode();
    const { body } = await reserveOrder('order-1');

    const res = await request(`/v1/redemptions/${body.redemption!.id}/settle`, {
      method: 'POST',
      ...json({ finalDiscountAmount: 2500 }),
    });
    expect(res.status).toBe(200);

    expect((await entries('capture')).map((c) => Number(c.amount))).toEqual([1500, 1000]);
    // Nothing is left open: what was held and not captured went back.
    expect((await entries('release')).map((r) => Number(r.amount))).toEqual([1500, 1000]);

    const check = await reconciliation();
    expect(check.settled).toMatchObject({ redemptions: 2500, ledger: 2500, agrees: true });
    expect(check.outstanding).toMatchObject({ redemptions: 0, ledger: 0, agrees: true });
  });

  it('is idempotent on the order reference', async () => {
    await createCode();
    const first = await reserveOrder('order-1');
    const second = await reserveOrder('order-1');

    expect(second.body.redemption!.id).toBe(first.body.redemption!.id);
    expect(await db()`select id from redemptions`).toHaveLength(1);
    expect(await entries('hold')).toHaveLength(2);
  });

  it('refuses to settle what is released, or release what is settled', async () => {
    await createCode();
    const a = await reserveOrder('order-1');
    await request(`/v1/redemptions/${a.body.redemption!.id}/release`, {
      method: 'POST',
      ...json({ reason: 'cancelled' }),
    });
    const settleReleased = await request(`/v1/redemptions/${a.body.redemption!.id}/settle`, {
      method: 'POST',
      ...json({}),
    });
    expect(settleReleased.status).toBe(409);

    const b = await reserveOrder('order-2');
    await request(`/v1/redemptions/${b.body.redemption!.id}/settle`, {
      method: 'POST',
      ...json({}),
    });
    const releaseSettled = await request(`/v1/redemptions/${b.body.redemption!.id}/release`, {
      method: 'POST',
      ...json({ reason: 'too late' }),
    });
    expect(releaseSettled.status).toBe(409);
  });
});

describe('the ledger itself', () => {
  it('refuses to capture or release the same hold twice', async () => {
    await createCode();
    const { body } = await reserveOrder('order-1');
    const hold = body.redemption!.holds[0]!;

    // The service's status guard would stop a second settle long before this,
    // but the invariant belongs in the database too: one capture and one
    // release per hold, never two of either.
    await expect(
      withTenant(TENANT_A, (tx) =>
        internalLedger.capture(tx, {
          tenantId: TENANT_A,
          redemptionId: body.redemption!.id,
          holdRef: hold.holdRef,
          amount: 1,
        }).then(() =>
          internalLedger.capture(tx, {
            tenantId: TENANT_A,
            redemptionId: body.redemption!.id,
            holdRef: hold.holdRef,
            amount: 1,
          }),
        ),
      ),
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  it('refuses to capture more than the hold is holding', async () => {
    await createCode();
    const { body } = await reserveOrder('order-1');
    const hold = body.redemption!.holds[0]!;

    await expect(
      withTenant(TENANT_A, (tx) =>
        internalLedger.capture(tx, {
          tenantId: TENANT_A,
          redemptionId: body.redemption!.id,
          holdRef: hold.holdRef,
          amount: hold.amount + 1,
        }),
      ),
    ).rejects.toThrow(/cannot capture/);
  });
});

describe('budgets', () => {
  it('stops at maxUses, perBuyerMaxUses and maxSpend', async () => {
    await createCode({ budget: { maxUses: 1 } });
    expect((await reserveOrder('order-1')).status).toBe(201);
    const second = await reserveOrder('order-2', 80000, { buyerRef: 'buyer-2' });
    expect(second.status).toBe(200);
    expect(second.body.reason).toBe('budget_uses');

    await db()`delete from ledger_entries`;
    await db()`delete from redemptions`;
    await db()`delete from promocodes`;

    await createCode({ budget: { perBuyerMaxUses: 1 } });
    expect((await reserveOrder('order-3')).status).toBe(201);
    const sameBuyer = await reserveOrder('order-4');
    expect(sameBuyer.body.reason).toBe('budget_buyer');

    await db()`delete from ledger_entries`;
    await db()`delete from redemptions`;
    await db()`delete from promocodes`;

    await createCode({ budget: { maxSpend: 6000 } });
    expect((await reserveOrder('order-5')).status).toBe(201);
    expect(await validateCode(80000)).toMatchObject({ valid: false, reason: 'budget_spend' });
  });

  it('lets exactly one of two parallel reserves through', async () => {
    await createCode({ budget: { maxUses: 1 } });

    const attempt = (orderRef: string, buyerRef: string) =>
      withTenant(TENANT_A, (tx) =>
        reserve(tx, {
          tenantId: TENANT_A,
          code: 'SAVE10',
          buyerRef,
          cart: cart(80000),
          orderRef,
        }),
      );

    const [one, two] = await Promise.all([
      attempt('race-1', 'buyer-1'),
      attempt('race-2', 'buyer-2'),
    ]);

    const outcomes = [one, two];
    expect(outcomes.filter((o) => o.reserved)).toHaveLength(1);
    expect(outcomes.filter((o) => !o.reserved)).toHaveLength(1);
    expect(outcomes.find((o) => !o.reserved)).toMatchObject({ reason: 'budget_uses' });

    // Exactly one set of holds exists.
    expect(await entries('hold')).toHaveLength(2);
  });
});

describe('expiry', () => {
  it('releases a reservation whose order never completed', async () => {
    await createCode();
    const { body } = await reserveOrder('order-1');

    await db()`
      update redemptions set expires_at = now() - interval '1 minute'
      where id = ${body.redemption!.id}
    `;

    expect(await expireReservations()).toBe(1);

    const [row] = await db()<{ status: string; release_reason: string }[]>`
      select status, release_reason from redemptions where id = ${body.redemption!.id}
    `;
    expect(row!.status).toBe('released');
    expect(row!.release_reason).toBe('expired');
    expect(await entries('release')).toHaveLength(2);

    expect((await reconciliation()).outstanding.agrees).toBe(true);
  });
});

describe('rules', () => {
  it("applies the code's own condition and a platform rule", async () => {
    // The code's document says when it MAY be used.
    await createCode({ rules: { '>=': [{ var: 'cart.subtotal' }, 100000] } });
    expect(await validateCode(50000)).toMatchObject({ valid: false, reason: 'rule' });
    expect(await validateCode(120000)).toMatchObject({ valid: true });

    // A platform rule denies when it matches, whatever the code says.
    await db()`
      insert into rules (scope, kind, name, document)
      values ('platform', 'promo_eligibility', 'no-banned-buyers',
              ${db().json({ '==': [{ var: 'buyerRef' }, 'banned'] } as never)})
    `;
    const banned = await validateCode(120000, { buyerRef: 'banned' });
    expect(banned).toMatchObject({ valid: false, reason: 'rule' });
  });
});

describe('rounding', () => {
  it('splits a discount three ways without losing a halala', async () => {
    await createCode({
      code: 'THIRDS',
      discount: { type: 'fixed', value: 1000 },
      funders: [
        { party: 'a', share: 1 / 3 },
        { party: 'b', share: 1 / 3 },
        { party: 'c', share: 1 / 3 },
      ],
    });

    const res = await request('/v1/redemptions', {
      method: 'POST',
      ...json({
        code: 'THIRDS',
        buyerRef: 'buyer-1',
        cart: cart(80000),
        orderRef: 'order-thirds',
      }),
    });
    expect(res.status).toBe(201);

    const amounts = (await entries('hold')).map((h) => Number(h.amount));
    expect(amounts).toEqual([334, 333, 333]);
    expect(amounts.reduce((a, b) => a + b, 0)).toBe(1000);
  });
});

describe('ledger selection', () => {
  it('fails loudly and writes nothing when the finance engine is not configured', async () => {
    await createCode();
    process.env.LEDGER = 'finance-engine';

    const res = await request('/v1/redemptions', {
      method: 'POST',
      ...json({ code: 'SAVE10', buyerRef: 'buyer-1', cart: cart(80000), orderRef: 'order-1' }),
    });
    expect(res.status).toBe(500);

    // The whole reservation rolled back with the failed hold.
    expect(await db()`select id from redemptions`).toHaveLength(0);
    expect(await db()`select id from ledger_entries`).toHaveLength(0);
  });
});

describe('tenant isolation', () => {
  it("hides tenant A's codes, redemptions and ledger from tenant B", async () => {
    const promo = await createCode();
    await reserveOrder('order-1');

    expect((await request(`/v1/promocodes/${promo.id}`, {}, tokenB)).status).toBe(404);

    const codes = await withTenant(TENANT_B, (tx) => tx`select id from promocodes`);
    const redemptions = await withTenant(TENANT_B, (tx) => tx`select id from redemptions`);
    const ledger = await withTenant(TENANT_B, (tx) => tx`select id from ledger_entries`);
    expect(codes).toHaveLength(0);
    expect(redemptions).toHaveLength(0);
    expect(ledger).toHaveLength(0);
  });
});
