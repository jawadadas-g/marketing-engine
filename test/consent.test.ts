import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/api/app.js';
import { db, withTenant } from '../src/db/client.js';
import { TENANT_A, TENANT_B, resetDb, teardownDb, tokenFor } from './helpers.js';

const app = createApp();

// Pinned clocks. Riyadh is UTC+3 all year, so these are 10:00 and 23:00 local.
const AT_10_RIYADH = '2026-03-02T07:00:00.000Z';
const AT_23_RIYADH = '2026-03-02T20:00:00.000Z';

const PHONE = '+966501234567';

let tokenA: string;
let tokenB: string;

function request(path: string, init: RequestInit = {}, token = tokenA) {
  return app.fetch(
    new Request(`http://engine.test${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
    }),
  );
}

function grantSms(token = tokenA, address = PHONE, extra: Record<string, unknown> = {}) {
  return request(
    '/v1/consent',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel: 'sms',
        address,
        purpose: 'marketing',
        status: 'granted',
        source: 'signup-form',
        ...extra,
      }),
    },
    token,
  );
}

async function canSend(
  params: Record<string, string>,
  token = tokenA,
): Promise<{ allowed: boolean; reason?: string; rule?: { name: string } }> {
  const res = await request(`/v1/can-send?${new URLSearchParams(params)}`, {}, token);
  expect(res.status).toBe(200);
  return res.json() as never;
}

beforeAll(async () => {
  await resetDb();
  tokenA = await tokenFor(TENANT_A);
  tokenB = await tokenFor(TENANT_B);
});

afterAll(teardownDb);

beforeEach(resetDb);

describe('canSend', () => {
  it('refuses marketing to a number that never consented', async () => {
    const result = await canSend({
      channel: 'sms',
      address: PHONE,
      purpose: 'marketing',
      at: AT_10_RIYADH,
    });
    expect(result).toEqual({ allowed: false, reason: 'no_consent' });
  });

  it('allows marketing once consent is granted, inside the window', async () => {
    expect((await grantSms()).status).toBe(201);

    const result = await canSend({
      channel: 'sms',
      address: PHONE,
      purpose: 'marketing',
      at: AT_10_RIYADH,
    });
    expect(result).toEqual({ allowed: true });
  });

  it('refuses consented marketing outside the Saudi sending window', async () => {
    await grantSms();

    const result = await canSend({
      channel: 'sms',
      address: PHONE,
      purpose: 'marketing',
      at: AT_23_RIYADH,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('rule');
    expect(result.rule?.name).toBe('sa-marketing-sms-hours');
  });

  it('allows a transactional message at the same late hour', async () => {
    const result = await canSend({
      channel: 'sms',
      address: PHONE,
      purpose: 'transactional',
      at: AT_23_RIYADH,
    });
    expect(result).toEqual({ allowed: true });
  });

  it('refuses a revoked address even though it was granted first', async () => {
    await grantSms();
    const revoke = await request('/v1/consent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel: 'sms',
        address: PHONE,
        purpose: 'marketing',
        status: 'revoked',
        source: 'stop-reply',
      }),
    });
    expect(revoke.status).toBe(201);

    const result = await canSend({
      channel: 'sms',
      address: PHONE,
      purpose: 'marketing',
      at: AT_10_RIYADH,
    });
    expect(result).toEqual({ allowed: false, reason: 'no_consent' });
  });

  it('treats the same number written two ways as one contact', async () => {
    // National form with a default country, then the E.164 form.
    expect((await grantSms(tokenA, '0501234567', { defaultCountry: 'SA' })).status).toBe(201);

    const result = await canSend({
      channel: 'sms',
      address: '+966 50 123 4567',
      purpose: 'marketing',
      at: AT_10_RIYADH,
    });
    expect(result).toEqual({ allowed: true });

    const rows = await withTenant(TENANT_A, (tx) => tx`select address from consent`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.address).toBe(PHONE);
  });
});

describe('suppression', () => {
  const EMAIL = 'blocked@example.com';

  it("blocks an address the tenant suppressed, for that tenant", async () => {
    const res = await request('/v1/suppression', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'email', address: EMAIL, reason: 'complaint' }),
    });
    expect(res.status).toBe(201);

    const forA = await canSend({ channel: 'email', address: EMAIL, purpose: 'transactional' });
    expect(forA).toEqual({ allowed: false, reason: 'suppressed' });

    // Tenant B never suppressed it, so B is unaffected.
    const forB = await canSend(
      { channel: 'email', address: EMAIL, purpose: 'transactional' },
      tokenB,
    );
    expect(forB).toEqual({ allowed: true });
  });

  it('blocks a platform-wide suppression for every tenant', async () => {
    // Written as the owning role: no tenant can create a platform-wide block.
    await db()`
      insert into suppression (tenant_id, channel, address, reason)
      values (null, 'email', ${EMAIL}, 'global-bounce')
    `;

    for (const token of [tokenA, tokenB]) {
      const result = await canSend(
        { channel: 'email', address: EMAIL, purpose: 'transactional' },
        token,
      );
      expect(result).toEqual({ allowed: false, reason: 'suppressed' });
    }
  });
});

describe('tenant isolation', () => {
  it("hides tenant A's consent rows from tenant B", async () => {
    await grantSms();

    const asA = await withTenant(TENANT_A, (tx) => tx`select id from consent`);
    const asB = await withTenant(TENANT_B, (tx) => tx`select id from consent`);
    expect(asA).toHaveLength(1);
    expect(asB).toHaveLength(0);
  });
});

describe('rules', () => {
  it('lets a tenant read the region rule but not delete it', async () => {
    const list = await request('/v1/rules');
    expect(list.status).toBe(200);
    const { rules } = (await list.json()) as {
      rules: { id: string; name: string; scope: string }[];
    };
    const seeded = rules.find((r) => r.name === 'sa-marketing-sms-hours');
    expect(seeded?.scope).toBe('region');

    const res = await request(`/v1/rules/${seeded!.id}`, { method: 'DELETE' });
    expect(res.status).toBe(404);

    const [still] = await db()`select name from rules where id = ${seeded!.id}`;
    expect(still?.name).toBe('sa-marketing-sms-hours');
  });

  it('lets a tenant add its own rule and delete it again', async () => {
    const create = await request('/v1/rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'sending_window',
        name: 'no-fridays',
        document: { '==': [{ var: 'weekday' }, 'fri'] },
      }),
    });
    expect(create.status).toBe(201);
    const { rule } = (await create.json()) as { rule: { id: string } };

    await grantSms();
    // 2026-03-06 is a Friday.
    const friday = await canSend({
      channel: 'sms',
      address: PHONE,
      purpose: 'marketing',
      at: '2026-03-06T07:00:00.000Z',
    });
    expect(friday.allowed).toBe(false);
    expect(friday.rule?.name).toBe('no-fridays');

    expect((await request(`/v1/rules/${rule.id}`, { method: 'DELETE' })).status).toBe(204);
  });
});
