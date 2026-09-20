import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app.js';
import { db, withTenant } from '../../src/db/client.js';
import { whatsappMetaAdapter } from '../../src/modules/messaging/adapters/whatsapp-meta.js';
import { send } from '../../src/modules/messaging/index.js';
import { processSend } from '../../src/modules/messaging/worker.js';
import { TENANT_A, resetDb, startQueue } from '../helpers.js';
import { configureLive } from './helpers.js';

const accessToken = process.env.WA_ACCESS_TOKEN;
const phoneNumberId = process.env.WA_PHONE_NUMBER_ID;
const templateName = process.env.WA_TEMPLATE_NAME;
const to = process.env.LIVE_WA_TO;

const configured = Boolean(accessToken && phoneNumberId && templateName && to);
void createApp();

describe.runIf(configured)('whatsapp-meta, live', () => {
  const config = {
    accessToken: accessToken ?? '',
    phoneNumberId: phoneNumberId ?? '',
    appSecret: process.env.WA_APP_SECRET ?? '',
  };

  beforeAll(async () => {
    await resetDb();
    await startQueue();
  });

  it('accepts the credentials', async () => {
    const check = await whatsappMetaAdapter.validateCredentials(config, '');
    console.log('validateCredentials:', check);
    expect(check.ok).toBe(true);
  });

  it('sends one real WhatsApp template message', async () => {
    await configureLive({
      channel: 'whatsapp',
      provider: 'whatsapp-meta',
      sender: 'live-test',
      config,
      body: 'Marketing engine test {{ n }}',
      providerRef: {
        name: templateName!,
        language: process.env.WA_TEMPLATE_LANG ?? 'en_US',
        params: [],
      },
    });

    const message = await withTenant(TENANT_A, (tx) =>
      send(tx, {
        tenantId: TENANT_A,
        contact: { phone: to! },
        channel: 'whatsapp',
        purpose: 'transactional',
        template: 'live',
        variables: { n: Date.now() % 10_000 },
      }),
    );

    await processSend(message.id);

    const [row] = await db()<{ status: string; provider_message_id: string }[]>`
      select status, provider_message_id from messages where id = ${message.id}
    `;
    console.log('whatsapp provider id:', row?.provider_message_id);
    expect(row!.status).toBe('sent');
    expect(row!.provider_message_id).toMatch(/^wamid\./);
  });
});

describe.skipIf(configured)('whatsapp-meta, live', () => {
  it('is skipped without WA_ACCESS_TOKEN, WA_PHONE_NUMBER_ID, WA_TEMPLATE_NAME and LIVE_WA_TO', () => {
    expect(configured).toBe(false);
  });
});
