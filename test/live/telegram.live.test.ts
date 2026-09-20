import { beforeAll, describe, expect, it } from 'vitest';
import { db, withTenant } from '../../src/db/client.js';
import { telegramAdapter } from '../../src/modules/messaging/adapters/telegram.js';
import { send } from '../../src/modules/messaging/index.js';
import { processSend } from '../../src/modules/messaging/worker.js';
import { TENANT_A, resetDb, startQueue } from '../helpers.js';
import { configureLive } from './helpers.js';

const botToken = process.env.TG_BOT_TOKEN;
const chatId = process.env.LIVE_TG_CHAT_ID;

const configured = Boolean(botToken && chatId);

describe.runIf(configured)('telegram, live', () => {
  const config = { botToken: botToken ?? '' };

  beforeAll(async () => {
    await resetDb();
    await startQueue();
  });

  it('accepts the bot token', async () => {
    const check = await telegramAdapter.validateCredentials(config, '');
    console.log('validateCredentials:', check);
    expect(check.ok).toBe(true);
  });

  it('sends one real Telegram message', async () => {
    await configureLive({
      channel: 'telegram',
      provider: 'telegram',
      sender: 'live-test',
      config,
      body: 'Marketing engine test {{ n }}',
    });

    const message = await withTenant(TENANT_A, (tx) =>
      send(tx, {
        tenantId: TENANT_A,
        contact: { telegram: chatId! },
        channel: 'telegram',
        purpose: 'transactional',
        template: 'live',
        variables: { n: Date.now() % 10_000 },
      }),
    );

    await processSend(message.id);

    const [row] = await db()<{ status: string; provider_message_id: string }[]>`
      select status, provider_message_id from messages where id = ${message.id}
    `;
    console.log('telegram message id:', row?.provider_message_id);
    expect(row!.status).toBe('sent');
    expect(row!.provider_message_id).toMatch(/^\d+$/);
  });
});

describe.skipIf(configured)('telegram, live', () => {
  it('is skipped without TG_BOT_TOKEN and LIVE_TG_CHAT_ID', () => {
    expect(configured).toBe(false);
  });
});
