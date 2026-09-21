import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/api/app.js';
import { db, withTenant } from '../src/db/client.js';
import { loadEnv, resetEnv } from '../src/env.js';
import { deliver, fanOut, verifyPayload } from '../src/modules/webhooks/index.js';
import { emit } from '../src/spine/events/index.js';
import { TENANT_A, TENANT_B, resetDb, startQueue, teardownDb, tokenFor } from './helpers.js';

const app = createApp();
const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN!;

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

/** A stand-in for the marketplace's own receiver. */
type Received = { headers: Record<string, string>; body: string };

async function listener(handler: () => number): Promise<{
  url: string;
  received: Received[];
  close: () => Promise<void>;
}> {
  const received: Received[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      received.push({ headers: req.headers as Record<string, string>, body });
      res.writeHead(handler()).end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;

  return {
    url: `http://127.0.0.1:${port}/hook`,
    received,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

type Endpoint = { webhook: { id: string }; secret: string };

async function registerEndpoint(url: string, eventTypes?: string[]): Promise<Endpoint> {
  const res = await request('/v1/webhooks', {
    method: 'POST',
    ...json({ url, ...(eventTypes ? { eventTypes } : {}) }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as Endpoint;
}

/** Emit one event the way a module would, then run its fan-out. */
async function emitAndFanOut(type = 'test.happened'): Promise<string> {
  const id = await withTenant(TENANT_A, async (tx) => {
    const row = await emit(tx, { tenantId: TENANT_A, type, payload: { n: 1 } });
    return String(row.id);
  });
  await fanOut(id);
  return id;
}

beforeAll(async () => {
  await resetDb();
  await startQueue();
  tokenA = await tokenFor(TENANT_A);
  tokenB = await tokenFor(TENANT_B);
});

afterAll(teardownDb);

beforeEach(resetDb);

describe('environment', () => {
  it('refuses to start without a credentials key, and names it', () => {
    resetEnv();
    const { CREDENTIALS_KEY: _dropped, ...rest } = process.env;
    expect(() => loadEnv(rest)).toThrow(/CREDENTIALS_KEY/);
    resetEnv();
  });

  it('lists every problem at once rather than the first', () => {
    resetEnv();
    const { CREDENTIALS_KEY: _a, JWT_SECRET: _b, ...rest } = process.env;
    try {
      loadEnv(rest);
      throw new Error('expected loadEnv to throw');
    } catch (err) {
      expect((err as Error).message).toMatch(/CREDENTIALS_KEY/);
      expect((err as Error).message).toMatch(/JWT_SECRET/);
    }
    resetEnv();
  });
});

describe('tenant provisioning', () => {
  it('is idempotent on the marketplace reference', async () => {
    const body = json({ name: 'Acme', externalRef: 'mkt-company-1' });
    const headers = { ...body.headers, 'X-Internal-Token': INTERNAL_TOKEN };

    const first = await request('/internal/tenants', { method: 'POST', ...body, headers }, null);
    expect(first.status).toBe(201);
    const { tenantId } = (await first.json()) as { tenantId: string };

    const second = await request('/internal/tenants', { method: 'POST', ...body, headers }, null);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ tenantId });

    const rows = await db()`select id from tenants where external_ref = 'mkt-company-1'`;
    expect(rows).toHaveLength(1);

    const events = await withTenant(
      tenantId,
      (tx) => tx`select id from events where type = 'tenant.created'`,
    );
    expect(events).toHaveLength(1);
  });

  it('refuses a wrong internal token', async () => {
    const res = await request(
      '/internal/tenants',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Internal-Token': 'nope' },
        body: JSON.stringify({ name: 'Acme', externalRef: 'mkt-2' }),
      },
      null,
    );
    expect(res.status).toBe(401);
  });
});

describe('fan-out', () => {
  it('creates one delivery per matching endpoint, and none for a rollback', async () => {
    const hook = await listener(() => 200);
    try {
      const matching = await registerEndpoint(hook.url, ['test.happened']);
      const other = await registerEndpoint(hook.url, ['something.else']);
      const all = await registerEndpoint(hook.url);

      // The platform endpoint hears every tenant.
      const platform = await request(
        '/internal/webhooks',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Internal-Token': INTERNAL_TOKEN },
          body: JSON.stringify({ url: hook.url }),
        },
        null,
      );
      expect(platform.status).toBe(201);
      const platformId = ((await platform.json()) as Endpoint).webhook.id;

      // An event that never commits reaches nobody: the fan-out job rides the
      // same transaction, so there is not even a job to run.
      await db()`delete from pgboss.job where name = 'webhook.fanout'`;
      await expect(
        withTenant(TENANT_A, async (tx) => {
          await emit(tx, { tenantId: TENANT_A, type: 'test.happened' });
          throw new Error('deliberate rollback');
        }),
      ).rejects.toThrow('deliberate rollback');

      expect(await db()`select id from pgboss.job where name = 'webhook.fanout'`).toHaveLength(0);
      expect(await db()`select id from webhook_deliveries`).toHaveLength(0);

      await emitAndFanOut('test.happened');

      const deliveries = await db()<{ endpoint_id: string }[]>`
        select endpoint_id from webhook_deliveries
      `;
      const targets = deliveries.map((d) => d.endpoint_id).sort();
      expect(targets).toEqual([matching.webhook.id, all.webhook.id, platformId].sort());
      expect(targets).not.toContain(other.webhook.id);
    } finally {
      await hook.close();
    }
  });
});

describe('delivery', () => {
  it('signs the body so a receiver can verify it', async () => {
    const hook = await listener(() => 200);
    try {
      const endpoint = await registerEndpoint(hook.url);
      await emitAndFanOut();

      const [delivery] = await db()<{ id: string }[]>`select id from webhook_deliveries`;
      expect(await deliver(delivery!.id)).toBe('delivered');

      expect(hook.received).toHaveLength(1);
      const got = hook.received[0]!;

      expect(
        verifyPayload({
          secret: endpoint.secret,
          id: got.headers['webhook-id']!,
          timestamp: Number(got.headers['webhook-timestamp']),
          body: got.body,
          signature: got.headers['webhook-signature']!,
        }),
      ).toBe(true);

      // A body that changed in flight does not verify.
      expect(
        verifyPayload({
          secret: endpoint.secret,
          id: got.headers['webhook-id']!,
          timestamp: Number(got.headers['webhook-timestamp']),
          body: `${got.body} tampered`,
          signature: got.headers['webhook-signature']!,
        }),
      ).toBe(false);

      const parsed = JSON.parse(got.body) as { type: string; tenantId: string; data: unknown };
      expect(parsed.type).toBe('test.happened');
      expect(parsed.tenantId).toBe(TENANT_A);
      expect(parsed.data).toEqual({ n: 1 });
    } finally {
      await hook.close();
    }
  });

  it('retries on rejection, gives up, and can be replayed', async () => {
    let answer = 500;
    const hook = await listener(() => answer);
    try {
      await registerEndpoint(hook.url);
      await emitAndFanOut();
      const [delivery] = await db()<{ id: string }[]>`select id from webhook_deliveries`;

      // Five scheduled attempts, then no more.
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        expect(await deliver(delivery!.id)).toBe('pending');
        const [row] = await db()<{ attempt: number; next_attempt_at: Date | null }[]>`
          select attempt, next_attempt_at from webhook_deliveries where id = ${delivery!.id}
        `;
        expect(row!.attempt).toBe(attempt);
        expect(row!.next_attempt_at).not.toBeNull();
      }

      expect(await deliver(delivery!.id)).toBe('failed');
      const [dead] = await db()<{ status: string; last_status_code: number }[]>`
        select status, last_status_code from webhook_deliveries where id = ${delivery!.id}
      `;
      expect(dead!.status).toBe('failed');
      expect(dead!.last_status_code).toBe(500);

      // The receiver comes back; a replay gets through.
      answer = 200;
      const replayed = await request(
        `/v1/webhooks/${(await db()<{ endpoint_id: string }[]>`select endpoint_id from webhook_deliveries`)[0]!.endpoint_id}/deliveries/${delivery!.id}/replay`,
        { method: 'POST' },
      );
      expect(replayed.status).toBe(202);

      const [reset] = await db()<{ status: string }[]>`
        select status from webhook_deliveries where id = ${delivery!.id}
      `;
      expect(reset!.status).toBe('pending');

      expect(await deliver(delivery!.id)).toBe('delivered');
    } finally {
      await hook.close();
    }
  });
});

describe('idempotency', () => {
  async function aCode() {
    const res = await request('/v1/promocodes', {
      method: 'POST',
      ...json({
        code: 'WIRED',
        currency: 'SAR',
        discount: { type: 'percent', value: 1000, maxDiscount: 5000 },
        funders: [{ party: 'platform', share: 1 }],
      }),
    });
    expect(res.status).toBe(201);
  }

  const body = (orderRef: string) => ({
    code: 'WIRED',
    buyerRef: 'buyer-1',
    cart: { currency: 'SAR', subtotal: 80000, items: [] },
    orderRef,
  });

  it('requires a key on the money routes', async () => {
    await aCode();
    const res = await request('/v1/redemptions', { method: 'POST', ...json(body('order-1')) });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'idempotency_key_required' });
  });

  it('refuses the same key with a different body, and replays the same one', async () => {
    await aCode();
    const send = (orderRef: string) =>
      request('/v1/redemptions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'one-key' },
        body: JSON.stringify(body(orderRef)),
      });

    const first = await send('order-1');
    expect(first.status).toBe(201);
    const firstBody = await first.text();

    const reused = await send('order-2');
    expect(reused.status).toBe(422);
    expect(await reused.json()).toMatchObject({ error: 'idempotency_key_reused' });

    const replayed = await send('order-1');
    expect(replayed.status).toBe(201);
    expect(await replayed.text()).toBe(firstBody);
    expect(replayed.headers.get('Idempotency-Replayed')).toBe('true');
  });
});

describe('tenant isolation', () => {
  it("hides A's endpoints and deliveries from B, and the platform's from everyone", async () => {
    const hook = await listener(() => 200);
    try {
      await registerEndpoint(hook.url);
      await request(
        '/internal/webhooks',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Internal-Token': INTERNAL_TOKEN },
          body: JSON.stringify({ url: hook.url }),
        },
        null,
      );
      await emitAndFanOut();

      const forB = await request('/v1/webhooks', {}, tokenB);
      expect(((await forB.json()) as { webhooks: unknown[] }).webhooks).toHaveLength(0);

      // A sees its own and not the platform's.
      const forA = await request('/v1/webhooks');
      expect(((await forA.json()) as { webhooks: unknown[] }).webhooks).toHaveLength(1);

      const endpointsB = await withTenant(TENANT_B, (tx) => tx`select id from webhook_endpoints`);
      const deliveriesB = await withTenant(TENANT_B, (tx) => tx`select id from webhook_deliveries`);
      expect(endpointsB).toHaveLength(0);
      expect(deliveriesB).toHaveLength(0);
    } finally {
      await hook.close();
    }
  });
});

describe('health', () => {
  it('reports the database and the queue', async () => {
    const res = await request('/health', {}, null);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, db: true });
  });
});
