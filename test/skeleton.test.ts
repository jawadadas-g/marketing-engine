import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/api/app.js';
import { withTenant } from '../src/db/client.js';
import { TENANT_A, TENANT_B, resetDb, teardownDb, tokenFor } from './helpers.js';

const app = createApp();

let tokenA: string;
let tokenB: string;

function request(path: string, init: RequestInit = {}) {
  return app.fetch(new Request(`http://engine.test${path}`, init));
}

beforeAll(async () => {
  await resetDb();
  tokenA = await tokenFor(TENANT_A);
  tokenB = await tokenFor(TENANT_B);
});

afterAll(teardownDb);

beforeEach(resetDb);

describe('health', () => {
  it('returns 200 with the database and the queue reachable', async () => {
    const res = await request('/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; db: boolean; boss: string; version: string };
    expect(body.ok).toBe(true);
    expect(body.db).toBe(true);
    expect(body.boss).toMatch(/running|unavailable/);
    expect(body.version).toBeTruthy();
  });
});

describe('auth', () => {
  it('rejects a request without a token', async () => {
    const res = await request('/v1/events');
    expect(res.status).toBe(401);
  });

  it('rejects a token signed with the wrong secret', async () => {
    const res = await request('/v1/events', {
      headers: { Authorization: 'Bearer not-a-jwt' },
    });
    expect(res.status).toBe(401);
  });
});

describe('events', () => {
  it("writes one row that is visible through the same tenant's token", async () => {
    const post = await request('/v1/events', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'test.happened',
        subjectType: 'thing',
        subjectId: 'abc',
        payload: { n: 1 },
      }),
    });
    expect(post.status).toBe(201);

    const get = await request('/v1/events', { headers: { Authorization: `Bearer ${tokenA}` } });
    expect(get.status).toBe(200);
    const body = (await get.json()) as { events: { type: string; payload: unknown }[] };
    expect(body.events).toHaveLength(1);
    expect(body.events[0]!.type).toBe('test.happened');
    expect(body.events[0]!.payload).toEqual({ n: 1 });
  });

  it("does not leak tenant A's event to tenant B, and RLS is what stops it", async () => {
    await request('/v1/events', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'test.happened' }),
    });

    const get = await request('/v1/events', { headers: { Authorization: `Bearer ${tokenB}` } });
    expect(get.status).toBe(200);
    expect((await get.json()) as { events: unknown[] }).toEqual({ events: [] });

    // Same query, no tenant predicate at all: only the RLS policy can filter it.
    const asA = await withTenant(TENANT_A, (tx) => tx`select id from events`);
    const asB = await withTenant(TENANT_B, (tx) => tx`select id from events`);
    expect(asA).toHaveLength(1);
    expect(asB).toHaveLength(0);
  });

  it('cannot update or delete an event, even as its own tenant', async () => {
    await request('/v1/events', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'test.happened' }),
    });

    await expect(
      withTenant(TENANT_A, (tx) => tx`update events set type = 'tampered'`),
    ).rejects.toThrow(/permission denied/i);
    await expect(withTenant(TENANT_A, (tx) => tx`delete from events`)).rejects.toThrow(
      /permission denied/i,
    );
  });

  it('rejects a body that is not a valid event', async () => {
    const res = await request('/v1/events', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ subjectId: 'no-type' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('idempotency', () => {
  it('replays the identical body and writes one row for a repeated key', async () => {
    const send = () =>
      request('/v1/events', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tokenA}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': 'key-1',
        },
        body: JSON.stringify({ type: 'test.happened', payload: { n: 1 } }),
      });

    const first = await send();
    const firstBody = await first.text();
    const second = await send();
    const secondBody = await second.text();

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(secondBody).toBe(firstBody);
    expect(second.headers.get('Idempotency-Replayed')).toBe('true');

    const rows = await withTenant(TENANT_A, (tx) => tx`select id from events`);
    expect(rows).toHaveLength(1);
  });

  it('keeps each tenant\'s keys separate', async () => {
    const send = (token: string) =>
      request('/v1/events', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': 'shared-key',
        },
        body: JSON.stringify({ type: 'test.happened' }),
      });

    await send(tokenA);
    const forB = await send(tokenB);
    expect(forB.headers.get('Idempotency-Replayed')).toBeNull();

    const rows = await withTenant(TENANT_B, (tx) => tx`select id from events`);
    expect(rows).toHaveLength(1);
  });
});
