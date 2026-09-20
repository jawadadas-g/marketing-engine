import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/api/app.js';
import { db, withTenant } from '../src/db/client.js';
import { failFakeSends, fakeCalls, resetFake } from '../src/modules/messaging/adapters/fake.js';
import { unsubscribeToken } from '../src/modules/messaging/unsubscribe.js';
import { processSend } from '../src/modules/messaging/worker.js';
import { enqueue } from '../src/jobs/index.js';
import { SEND_JOB } from '../src/modules/messaging/index.js';
import type { Channel } from '../src/spine/contacts/normalize.js';
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

const TOKEN = process.env.WEBHOOK_TOKEN!;
const PHONE = '+966501234567';
const EMAIL = 'someone@example.com';
const TELEGRAM = '987654321';
const AT_10_RIYADH = '2026-03-02T07:00:00.000Z';

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

async function configureAll(token = tokenA) {
  for (const channel of ['sms', 'whatsapp', 'email', 'telegram'] as Channel[]) {
    const res = await request(
      `/v1/channels/${channel}`,
      {
        method: 'PUT',
        ...json({
          provider: 'fake',
          sender: channel === 'email' ? 'hello@acme.test' : 'ACME',
          unsubscribeText: 'Reply STOP to unsubscribe',
          config: { token: 'good', phoneNumberId: '1234567890', appSecret: 'shh' },
        }),
      },
      token,
    );
    expect(res.status).toBe(200);
  }
}

async function putTemplates(token = tokenA) {
  const rows: Record<string, unknown>[] = [
    { channel: 'sms', body: 'Hi {{ name }}' },
    {
      channel: 'whatsapp',
      body: 'Hi {{ name }}',
      providerRef: { name: 'greet', language: 'en', params: ['name'] },
    },
    { channel: 'email', body: 'Hi {{ name }}', subject: 'Hello {{ name }}' },
    { channel: 'telegram', body: 'Hi {{ name }}' },
  ];
  for (const row of rows) {
    const res = await request('/v1/templates/greet', { method: 'PUT', ...json(row) }, token);
    expect(res.status).toBe(200);
  }
}

function consent(channel: Channel, address: string, token = tokenA) {
  return request(
    '/v1/consent',
    {
      method: 'POST',
      ...json({
        channel,
        address,
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
  channel: string;
  status: string;
  body: string;
  blockedReason: string | null;
  fallbackChannels: string[];
  parentMessageId: string | null;
};

function postIntent(body: Record<string, unknown>, token = tokenA) {
  return request('/v1/messages', { method: 'POST', ...json(body) }, token);
}

async function intent(body: Record<string, unknown>, token = tokenA): Promise<Message> {
  const res = await postIntent(body, token);
  const payload = (await res.json()) as { message: Message };
  return payload.message;
}

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

describe('part A fixes', () => {
  it('leaves no job behind when the sending transaction rolls back', async () => {
    await expect(
      withTenant(TENANT_A, async (tx) => {
        await enqueue(tx, SEND_JOB, { messageId: 'never-committed' });
        throw new Error('deliberate rollback');
      }),
    ).rejects.toThrow('deliberate rollback');

    expect(await sendJobCount()).toBe(0);
  });

  it('ignores a second delivery report for the same message', async () => {
    await configureAll();
    await putTemplates();
    const message = await intent({
      contact: { phone: PHONE },
      channel: 'sms',
      purpose: 'transactional',
      template: 'greet',
      variables: { name: 'Sam' },
    });
    await processSend(message.id);

    const report = () =>
      request(
        `/webhooks/fake/${TOKEN}`,
        { method: 'POST', ...json({ id: `fake-${message.id}`, status: 'delivered' }) },
        null,
      );

    expect((await report()).status).toBe(202);
    expect((await report()).status).toBe(202);

    const events = await withTenant(
      TENANT_A,
      (tx) => tx`select id from events where type = 'message.delivered'`,
    );
    expect(events).toHaveLength(1);
  });
});

describe('channel selection', () => {
  beforeEach(async () => {
    await configureAll();
    await putTemplates();
  });

  it('sends each contact on the one channel it consented to', async () => {
    const cases: { channel: Channel; address: string; contact: Record<string, string> }[] = [
      { channel: 'whatsapp', address: PHONE, contact: { phone: PHONE } },
      { channel: 'sms', address: PHONE, contact: { phone: PHONE } },
      { channel: 'email', address: EMAIL, contact: { email: EMAIL } },
      { channel: 'telegram', address: TELEGRAM, contact: { telegram: TELEGRAM } },
    ];

    for (const testCase of cases) {
      await resetDb();
      resetFake();
      await configureAll();
      await putTemplates();
      await consent(testCase.channel, testCase.address);

      const message = await intent({
        contact: testCase.contact,
        purpose: 'marketing',
        template: 'greet',
        variables: { name: 'Sam' },
        at: AT_10_RIYADH,
      });

      expect(message.status).toBe('queued');
      expect(message.channel).toBe(testCase.channel);
      expect(message.fallbackChannels).toEqual([]);
    }
  });

  it('refuses an explicit channel the contact has no address for', async () => {
    const res = await postIntent({
      contact: { phone: PHONE },
      channel: 'email',
      purpose: 'transactional',
      template: 'greet',
      variables: { name: 'Sam' },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'address_missing' });
  });

  it("lets a tenant's own rule override the platform order", async () => {
    await consent('whatsapp', PHONE);
    await consent('sms', PHONE);

    const before = await intent({
      contact: { phone: PHONE },
      purpose: 'marketing',
      template: 'greet',
      variables: { name: 'Sam' },
      at: AT_10_RIYADH,
    });
    expect(before.channel).toBe('whatsapp');

    const rule = await request('/v1/rules', {
      method: 'POST',
      ...json({
        kind: 'channel_selection',
        name: 'sms-only',
        document: { if: [{ '==': [{ var: 'purpose' }, 'marketing'] }, ['sms'], null] },
      }),
    });
    expect(rule.status).toBe(201);

    const after = await intent({
      contact: { phone: PHONE },
      purpose: 'marketing',
      template: 'greet',
      variables: { name: 'Sam' },
      at: AT_10_RIYADH,
    });
    expect(after.channel).toBe('sms');
  });

  it('blocks with no_channel and lists why, when nothing is consented', async () => {
    const message = await intent({
      contact: { phone: PHONE, email: EMAIL, telegram: TELEGRAM },
      purpose: 'marketing',
      template: 'greet',
      variables: { name: 'Sam' },
      at: AT_10_RIYADH,
    });

    expect(message.status).toBe('blocked');
    expect(message.blockedReason).toBe('no_channel');

    const [event] = await withTenant(
      TENANT_A,
      (tx) => tx<{ payload: { channels: Record<string, string> } }[]>`
        select payload from events where type = 'message.blocked'
      `,
    );
    expect(event!.payload.channels).toMatchObject({
      whatsapp: 'no_consent',
      sms: 'no_consent',
      email: 'no_consent',
      telegram: 'no_consent',
    });
  });
});

describe('fallback', () => {
  beforeEach(async () => {
    await configureAll();
    await putTemplates();
  });

  it('moves to the next channel when one fails for good', async () => {
    await consent('whatsapp', PHONE);
    await consent('sms', PHONE);

    const parent = await intent({
      contact: { phone: PHONE },
      purpose: 'marketing',
      template: 'greet',
      variables: { name: 'Sam' },
      at: AT_10_RIYADH,
    });
    expect(parent.channel).toBe('whatsapp');
    expect(parent.fallbackChannels).toEqual(['sms']);

    failFakeSends('whatsapp', new Error('whatsapp is down'));
    await expect(processSend(parent.id, { finalAttempt: true })).rejects.toThrow('whatsapp is down');

    const [parentRow] = await db()<{ status: string }[]>`
      select status from messages where id = ${parent.id}
    `;
    expect(parentRow!.status).toBe('failed');

    const [child] = await db()<{ id: string; channel: string; status: string }[]>`
      select id, channel, status from messages where parent_message_id = ${parent.id}
    `;
    expect(child!.channel).toBe('sms');
    expect(child!.status).toBe('queued');

    const events = await withTenant(
      TENANT_A,
      (tx) => tx<{ payload: { childMessageId: string } }[]>`
        select payload from events where type = 'message.fallback'
      `,
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.payload.childMessageId).toBe(child!.id);

    await processSend(child!.id);
    const [sent] = await db()<{ status: string }[]>`
      select status from messages where id = ${child!.id}
    `;
    expect(sent!.status).toBe('sent');
    expect(fakeCalls('sms')).toHaveLength(1);
  });

  it('records a blocked child when the next channel cannot use the template', async () => {
    // A WhatsApp template with no provider_ref cannot be sent at all.
    await request('/v1/templates/greet', {
      method: 'PUT',
      ...json({ channel: 'whatsapp', body: 'Hi {{ name }}' }),
    });
    await consent('sms', PHONE);
    await consent('whatsapp', PHONE);

    const rule = await request('/v1/rules', {
      method: 'POST',
      ...json({
        kind: 'channel_selection',
        name: 'sms-then-whatsapp',
        document: { if: [true, ['sms', 'whatsapp'], null] },
      }),
    });
    expect(rule.status).toBe(201);

    const parent = await intent({
      contact: { phone: PHONE },
      purpose: 'marketing',
      template: 'greet',
      variables: { name: 'Sam' },
      at: AT_10_RIYADH,
    });
    expect(parent.channel).toBe('sms');
    expect(parent.fallbackChannels).toEqual(['whatsapp']);

    failFakeSends('sms', new Error('sms is down'));
    await expect(processSend(parent.id, { finalAttempt: true })).rejects.toThrow('sms is down');

    const [child] = await db()<
      { channel: string; status: string; blocked_reason: string; fallback: string }[]
    >`
      select channel, status, blocked_reason, fallback_channels::text as fallback
      from messages where parent_message_id = ${parent.id}
    `;
    expect(child!.channel).toBe('whatsapp');
    expect(child!.status).toBe('blocked');
    expect(child!.blocked_reason).toBe('template_unfit');
    expect(child!.fallback).toBe('{}');
  });
});

describe('email unsubscribe', () => {
  beforeEach(async () => {
    await configureAll();
    await putTemplates();
  });

  it('carries the one-click headers and honours the link', async () => {
    await consent('email', EMAIL);

    const message = await intent({
      contact: { email: EMAIL },
      purpose: 'marketing',
      template: 'greet',
      variables: { name: 'Sam' },
      at: AT_10_RIYADH,
    });
    await processSend(message.id);

    const call = fakeCalls('email')[0];
    expect(call!.subject).toBe('Hello Sam');
    expect(call!.unsubscribeUrl).toContain('/unsubscribe/');

    const token = call!.unsubscribeUrl!.split('/unsubscribe/')[1]!;
    const res = await request(`/unsubscribe/${token}`, { method: 'POST' }, null);
    expect(res.status).toBe(200);

    const verdict = await request(
      `/v1/can-send?channel=email&address=${encodeURIComponent(EMAIL)}&purpose=marketing`,
    );
    expect(await verdict.json()).toMatchObject({ allowed: false, reason: 'suppressed' });
  });

  it('refuses a tampered token', async () => {
    const good = unsubscribeToken({ tenantId: TENANT_A, channel: 'email', address: EMAIL });
    const tampered = Buffer.from(
      Buffer.from(good, 'base64url').toString('utf8').replace(/:[0-9a-f]+$/, ':deadbeef'),
      'utf8',
    ).toString('base64url');

    const res = await request(`/unsubscribe/${tampered}`, { method: 'POST' }, null);
    expect(res.status).toBe(404);
  });
});

describe('whatsapp webhook', () => {
  const APP_SECRET = 'shh';

  function metaBody(statuses: unknown[] = [], messages: unknown[] = []) {
    return {
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: '1234567890' },
                ...(statuses.length ? { statuses } : {}),
                ...(messages.length ? { messages } : {}),
              },
            },
          ],
        },
      ],
    };
  }

  function signed(body: unknown) {
    const raw = JSON.stringify(body);
    return {
      headers: {
        'Content-Type': 'application/json',
        'X-Hub-Signature-256': `sha256=${createHmac('sha256', APP_SECRET).update(raw).digest('hex')}`,
      },
      body: raw,
    };
  }

  beforeEach(async () => {
    await configureAll();
    await putTemplates();
    // The fake adapter is registered for whatsapp, so point the config at the
    // real Meta provider for the signature path.
    await db()`update tenant_channel_configs set provider = 'whatsapp-meta' where channel = 'whatsapp'`;
  });

  it('accepts a signed delivery report and rejects an unsigned one', async () => {
    await consent('whatsapp', PHONE);
    const message = await intent({
      contact: { phone: PHONE },
      channel: 'whatsapp',
      purpose: 'marketing',
      template: 'greet',
      variables: { name: 'Sam' },
      at: AT_10_RIYADH,
    });
    await db()`
      update messages set status = 'sent', provider = 'whatsapp-meta',
        provider_message_id = 'wamid.TEST' where id = ${message.id}
    `;

    const body = metaBody([{ id: 'wamid.TEST', status: 'delivered' }]);

    const unsigned = await request(
      `/webhooks/whatsapp-meta/${TOKEN}`,
      { method: 'POST', ...json(body) },
      null,
    );
    expect(unsigned.status).toBe(401);

    const [untouched] = await db()<{ status: string }[]>`
      select status from messages where id = ${message.id}
    `;
    expect(untouched!.status).toBe('sent');

    const ok = await request(
      `/webhooks/whatsapp-meta/${TOKEN}`,
      { method: 'POST', ...signed(body) },
      null,
    );
    expect(ok.status).toBe(202);

    const [moved] = await db()<{ status: string }[]>`
      select status from messages where id = ${message.id}
    `;
    expect(moved!.status).toBe('delivered');
  });

  it('records an inbound message as a reply', async () => {
    await consent('whatsapp', PHONE);
    const message = await intent({
      contact: { phone: PHONE },
      channel: 'whatsapp',
      purpose: 'marketing',
      template: 'greet',
      variables: { name: 'Sam' },
      at: AT_10_RIYADH,
    });
    await db()`update messages set status = 'sent' where id = ${message.id}`;

    const body = metaBody([], [{ from: PHONE.slice(1), text: { body: 'STOP' } }]);
    const res = await request(
      `/webhooks/whatsapp-meta/${TOKEN}`,
      { method: 'POST', ...signed(body) },
      null,
    );
    expect(res.status).toBe(202);

    const events = await withTenant(
      TENANT_A,
      (tx) => tx<{ payload: { text: string } }[]>`
        select payload from events where type = 'message.replied'
      `,
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.payload.text).toBe('STOP');
  });

  it("echoes Meta's verification challenge", async () => {
    const res = await request(
      `/webhooks/whatsapp-meta/${TOKEN}?hub.mode=subscribe&hub.verify_token=${TOKEN}&hub.challenge=abc123`,
      {},
      null,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('abc123');
  });
});

describe('telegram webhook', () => {
  beforeEach(async () => {
    await configureAll();
    await putTemplates();
    await db()`update tenant_channel_configs set provider = 'telegram' where channel = 'telegram'`;
  });

  it('404s a wrong secret header and records a reply with the right one', async () => {
    await consent('telegram', TELEGRAM);
    const message = await intent({
      contact: { telegram: TELEGRAM },
      channel: 'telegram',
      purpose: 'marketing',
      template: 'greet',
      variables: { name: 'Sam' },
      at: AT_10_RIYADH,
    });
    await db()`update messages set status = 'sent' where id = ${message.id}`;

    const body = { message: { chat: { id: Number(TELEGRAM) }, text: 'hello back' } };

    const wrong = await request(
      `/webhooks/telegram/${TOKEN}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': 'nope' },
        body: JSON.stringify(body),
      },
      null,
    );
    expect(wrong.status).toBe(404);

    const right = await request(
      `/webhooks/telegram/${TOKEN}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': TOKEN },
        body: JSON.stringify(body),
      },
      null,
    );
    expect(right.status).toBe(202);

    const events = await withTenant(
      TENANT_A,
      (tx) => tx<{ payload: { text: string } }[]>`
        select payload from events where type = 'message.replied'
      `,
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.payload.text).toBe('hello back');
  });
});

describe('tenant isolation', () => {
  it("keeps tenant A's messages and templates away from tenant B", async () => {
    await configureAll();
    await putTemplates();
    await consent('sms', PHONE);
    await intent({
      contact: { phone: PHONE },
      channel: 'sms',
      purpose: 'marketing',
      template: 'greet',
      variables: { name: 'Sam' },
      at: AT_10_RIYADH,
    });

    const messages = await withTenant(TENANT_B, (tx) => tx`select id from messages`);
    const templates = await withTenant(TENANT_B, (tx) => tx`select id from templates`);
    expect(messages).toHaveLength(0);
    expect(templates).toHaveLength(0);
  });
});
