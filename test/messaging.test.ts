import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/api/app.js';
import { db, withTenant } from '../src/db/client.js';
import { failFakeSends, fakeCalls, resetFake } from '../src/modules/messaging/adapters/fake.js';
import { processSend } from '../src/modules/messaging/worker.js';
import {
  TENANT_A,
  TENANT_B,
  resetDb,
  sendJobCount,
  startQueue,
  teardownDb,
  tokenFor,
} from './helpers.js';

const app = createApp();

const PHONE = '+966501234567';
const AT_10_RIYADH = '2026-03-02T07:00:00.000Z';
const TOKEN = process.env.WEBHOOK_TOKEN!;

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

function configureFakeChannel(extra: Record<string, unknown> = {}, token = tokenA) {
  return request(
    '/v1/channels/sms',
    { method: 'PUT', ...json({ provider: 'fake', sender: 'ACME', config: { token: 'good' }, ...extra }) },
    token,
  );
}

function putTemplate(body: string, name = 'hello', token = tokenA) {
  return request(`/v1/templates/${name}`, { method: 'PUT', ...json({ channel: 'sms', body }) }, token);
}

function postMessage(body: Record<string, unknown>, token = tokenA) {
  return request('/v1/messages', { method: 'POST', ...json(body) }, token);
}

function grantConsent(token = tokenA) {
  return request(
    '/v1/consent',
    {
      method: 'POST',
      ...json({
        channel: 'sms',
        address: PHONE,
        purpose: 'marketing',
        status: 'granted',
        source: 'test',
      }),
    },
    token,
  );
}

type Message = {
  id: string;
  status: string;
  body: string;
  blockedReason: string | null;
  providerMessageId: string | null;
  error: string | null;
};

beforeAll(async () => {
  await resetDb();
  await startQueue();
  tokenA = await tokenFor(TENANT_A);
  tokenB = await tokenFor(TENANT_B);
});

afterAll(teardownDb);

beforeEach(async () => {
  await resetDb();
  resetFake();
});

describe('channel config', () => {
  it('rejects credentials the provider refuses and never echoes the token', async () => {
    const bad = await configureFakeChannel({ config: { token: 'bad' } });
    expect(bad.status).toBe(422);
    expect(await bad.json()).toMatchObject({ error: 'credentials_rejected' });

    const good = await configureFakeChannel();
    expect(good.status).toBe(200);
    const text = JSON.stringify(await good.json());
    expect(text).not.toContain('good');
    expect(text).toContain('"configured":true');

    // The stored credentials are ciphertext, not the token in the clear.
    const [row] = await db()<{ config_ciphertext: Buffer }[]>`
      select config_ciphertext from tenant_channel_configs
    `;
    expect(row!.config_ciphertext.toString('utf8')).not.toContain('good');
    expect(row!.config_ciphertext.toString('utf8')).not.toContain('token');
  });
});

describe('templates', () => {
  it('rejects a template that does not parse', async () => {
    const res = await putTemplate('Hello {{ name');
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'template_invalid' });
  });
});

describe('send', () => {
  beforeEach(async () => {
    await configureFakeChannel();
    await putTemplate('Hello {{ name }}');
  });

  it('records a blocked message and queues nothing when consent is missing', async () => {
    const res = await postMessage({
      channel: 'sms',
      address: PHONE,
      purpose: 'marketing',
      template: 'hello',
      variables: { name: 'Sam' },
      at: AT_10_RIYADH,
    });
    expect(res.status).toBe(200);

    const { message } = (await res.json()) as { message: Message };
    expect(message.status).toBe('blocked');
    expect(message.blockedReason).toBe('no_consent');

    const events = await withTenant(
      TENANT_A,
      (tx) => tx`select type from events where type = 'message.blocked'`,
    );
    expect(events).toHaveLength(1);
    expect(await sendJobCount()).toBe(0);
  });

  it('queues a transactional send and the worker sends it', async () => {
    const res = await postMessage({
      channel: 'sms',
      address: PHONE,
      purpose: 'transactional',
      template: 'hello',
      variables: { name: 'Sam' },
    });
    expect(res.status).toBe(202);

    const { message } = (await res.json()) as { message: Message };
    expect(message.status).toBe('queued');
    expect(message.body).toBe('Hello Sam');
    expect(await sendJobCount()).toBe(1);

    await processSend(message.id);

    const [row] = await db()<{ status: string; provider_message_id: string }[]>`
      select status, provider_message_id from messages where id = ${message.id}
    `;
    expect(row!.status).toBe('sent');
    expect(row!.provider_message_id).toBe(`fake-${message.id}`);

    expect(fakeCalls()).toHaveLength(1);
    expect(fakeCalls()[0]).toMatchObject({ to: PHONE, body: 'Hello Sam', sender: 'ACME' });

    const events = await withTenant(
      TENANT_A,
      (tx) => tx`select type from events where type = 'message.sent'`,
    );
    expect(events).toHaveLength(1);
  });

  it('refuses a send with a variable the template needs', async () => {
    const res = await postMessage({
      channel: 'sms',
      address: PHONE,
      purpose: 'transactional',
      template: 'hello',
      variables: {},
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; variable?: string };
    expect(body.error).toBe('template_variable_missing');
    expect(body.variable).toBe('name');

    const rows = await db()`select id from messages`;
    expect(rows).toHaveLength(0);
  });

  it('requires unsubscribe text for marketing, then appends it', async () => {
    await grantConsent();

    const without = await postMessage({
      channel: 'sms',
      address: PHONE,
      purpose: 'marketing',
      template: 'hello',
      variables: { name: 'Sam' },
      at: AT_10_RIYADH,
    });
    expect(without.status).toBe(422);
    expect(await without.json()).toMatchObject({ error: 'unsubscribe_text_required' });

    await configureFakeChannel({ unsubscribeText: 'Reply STOP to unsubscribe' });

    const withText = await postMessage({
      channel: 'sms',
      address: PHONE,
      purpose: 'marketing',
      template: 'hello',
      variables: { name: 'Sam' },
      at: AT_10_RIYADH,
    });
    expect(withText.status).toBe(202);
    const { message } = (await withText.json()) as { message: Message };
    expect(message.body).toBe('Hello Sam\nReply STOP to unsubscribe');
  });

  it('refuses a send when the channel has no provider configured', async () => {
    await db()`delete from tenant_channel_configs`;
    const res = await postMessage({
      channel: 'sms',
      address: PHONE,
      purpose: 'transactional',
      template: 'hello',
      variables: { name: 'Sam' },
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'channel_not_configured' });
  });

  it('marks the message failed on the final attempt and emits message.failed', async () => {
    const res = await postMessage({
      channel: 'sms',
      address: PHONE,
      purpose: 'transactional',
      template: 'hello',
      variables: { name: 'Sam' },
    });
    const { message } = (await res.json()) as { message: Message };

    failFakeSends(new Error('provider exploded'));

    // Not the last attempt: it throws and leaves the row alone for the retry.
    await expect(processSend(message.id)).rejects.toThrow('provider exploded');
    const [midway] = await db()<{ status: string }[]>`
      select status from messages where id = ${message.id}
    `;
    expect(midway!.status).toBe('queued');

    await expect(processSend(message.id, { finalAttempt: true })).rejects.toThrow(
      'provider exploded',
    );

    const [row] = await db()<{ status: string; error: string }[]>`
      select status, error from messages where id = ${message.id}
    `;
    expect(row!.status).toBe('failed');
    expect(row!.error).toContain('provider exploded');

    const events = await withTenant(
      TENANT_A,
      (tx) => tx`select type from events where type = 'message.failed'`,
    );
    expect(events).toHaveLength(1);
  });
});

describe('delivery webhook', () => {
  async function queueAndSend(): Promise<Message> {
    await configureFakeChannel();
    await putTemplate('Hello {{ name }}');
    const res = await postMessage({
      channel: 'sms',
      address: PHONE,
      purpose: 'transactional',
      template: 'hello',
      variables: { name: 'Sam' },
    });
    const { message } = (await res.json()) as { message: Message };
    await processSend(message.id);
    return message;
  }

  it('marks a message delivered', async () => {
    const message = await queueAndSend();

    const res = await request(
      `/webhooks/fake/${TOKEN}`,
      { method: 'POST', ...json({ id: `fake-${message.id}`, status: 'delivered' }) },
      null,
    );
    expect(res.status).toBe(202);

    const [row] = await db()<{ status: string }[]>`
      select status from messages where id = ${message.id}
    `;
    expect(row!.status).toBe('delivered');

    const events = await withTenant(
      TENANT_A,
      (tx) => tx`select type from events where type = 'message.delivered'`,
    );
    expect(events).toHaveLength(1);
  });

  it('404s a wrong token and changes nothing', async () => {
    const message = await queueAndSend();

    const res = await request(
      '/webhooks/fake/not-the-token',
      { method: 'POST', ...json({ id: `fake-${message.id}`, status: 'delivered' }) },
      null,
    );
    expect(res.status).toBe(404);

    const [row] = await db()<{ status: string }[]>`
      select status from messages where id = ${message.id}
    `;
    expect(row!.status).toBe('sent');
  });

  it('accepts an unknown id with 202 and changes nothing', async () => {
    const message = await queueAndSend();

    const res = await request(
      `/webhooks/fake/${TOKEN}`,
      { method: 'POST', ...json({ id: 'fake-nobody', status: 'delivered' }) },
      null,
    );
    expect(res.status).toBe(202);

    const [row] = await db()<{ status: string }[]>`
      select status from messages where id = ${message.id}
    `;
    expect(row!.status).toBe('sent');
  });
});

describe('tenant isolation', () => {
  it("hides tenant A's message from tenant B", async () => {
    await configureFakeChannel();
    await putTemplate('Hello {{ name }}');
    const res = await postMessage({
      channel: 'sms',
      address: PHONE,
      purpose: 'transactional',
      template: 'hello',
      variables: { name: 'Sam' },
    });
    const { message } = (await res.json()) as { message: Message };

    const forB = await request(`/v1/messages/${message.id}`, {}, tokenB);
    expect(forB.status).toBe(404);

    const asB = await withTenant(TENANT_B, (tx) => tx`select id from messages`);
    expect(asB).toHaveLength(0);
  });
});
