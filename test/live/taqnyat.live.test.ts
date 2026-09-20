import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app.js';
import { db, withTenant } from '../../src/db/client.js';
import { taqnyatAdapter } from '../../src/modules/messaging/adapters/taqnyat.js';
import { setChannelConfig, upsertTemplate } from '../../src/modules/messaging/index.js';
import { processSend } from '../../src/modules/messaging/worker.js';
import { TENANT_A, resetDb, startQueue, tokenFor } from '../helpers.js';

const bearer = process.env.TAQNYAT_BEARER;
const sender = process.env.TAQNYAT_SENDER;
const to = process.env.LIVE_SMS_TO;
const baseUrl = process.env.TAQNYAT_URL;

const configured = Boolean(bearer && sender && to);

const app = createApp();
let token: string;

const config = {
  token: bearer ?? '',
  ...(baseUrl ? { baseUrl } : {}),
};

describe.runIf(configured)('taqnyat, live', () => {
  beforeAll(async () => {
    await resetDb();
    await startQueue();
    token = await tokenFor(TENANT_A);
  });

  it('accepts the credentials and the sender', async () => {
    const check = await taqnyatAdapter.validateCredentials(config, sender!);
    console.log('validateCredentials:', check);
    expect(check.ok).toBe(true);
  });

  it('sends one real SMS and records the provider id', async () => {
    await withTenant(TENANT_A, (tx) =>
      setChannelConfig(tx, {
        tenantId: TENANT_A,
        channel: 'sms',
        provider: 'taqnyat',
        sender: sender!,
        config,
      }),
    );
    await withTenant(TENANT_A, (tx) =>
      upsertTemplate(tx, {
        tenantId: TENANT_A,
        name: 'live',
        channel: 'sms',
        body: 'Marketing engine test {{ n }}',
      }),
    );

    const res = await app.fetch(
      new Request('http://engine.test/v1/messages', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channel: 'sms',
          address: to,
          purpose: 'transactional',
          template: 'live',
          variables: { n: Date.now() % 10_000 },
        }),
      }),
    );
    expect(res.status).toBe(202);

    const { message } = (await res.json()) as { message: { id: string; body: string } };
    console.log('queued:', message.body);

    await processSend(message.id);

    const [row] = await db()<{ status: string; provider_message_id: string }[]>`
      select status, provider_message_id from messages where id = ${message.id}
    `;
    console.log('taqnyat provider response id:', row?.provider_message_id);

    expect(row!.status).toBe('sent');
    expect(row!.provider_message_id).toMatch(/^\d+$/);
  });
});

describe.skipIf(configured)('taqnyat, live', () => {
  it('is skipped without TAQNYAT_BEARER, TAQNYAT_SENDER and LIVE_SMS_TO', () => {
    expect(configured).toBe(false);
  });
});
