import { beforeAll, describe, expect, it } from 'vitest';
import { db, withTenant } from '../../src/db/client.js';
import { emailSmtpAdapter } from '../../src/modules/messaging/adapters/email-smtp.js';
import { send } from '../../src/modules/messaging/index.js';
import { processSend } from '../../src/modules/messaging/worker.js';
import { TENANT_A, resetDb, startQueue } from '../helpers.js';
import { configureLive } from './helpers.js';

const host = process.env.SMTP_HOST;
const from = process.env.SMTP_FROM;
const to = process.env.LIVE_EMAIL_TO;

const configured = Boolean(host && from && to);

describe.runIf(configured)('email-smtp, live', () => {
  const config = {
    host: host ?? '',
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_PORT === '465',
    user: process.env.SMTP_USER ?? '',
    pass: process.env.SMTP_PASS ?? '',
  };

  beforeAll(async () => {
    await resetDb();
    await startQueue();
  });

  it('accepts the credentials', async () => {
    const check = await emailSmtpAdapter.validateCredentials(config, from!);
    console.log('validateCredentials:', check);
    expect(check.ok).toBe(true);
  });

  it('sends one real email', async () => {
    await configureLive({
      channel: 'email',
      provider: 'email-smtp',
      sender: from!,
      config,
      body: 'Marketing engine test {{ n }}',
      subject: 'Marketing engine test {{ n }}',
    });

    const message = await withTenant(TENANT_A, (tx) =>
      send(tx, {
        tenantId: TENANT_A,
        contact: { email: to! },
        channel: 'email',
        purpose: 'transactional',
        template: 'live',
        variables: { n: Date.now() % 10_000 },
      }),
    );

    await processSend(message.id);

    const [row] = await db()<{ status: string; provider_message_id: string }[]>`
      select status, provider_message_id from messages where id = ${message.id}
    `;
    console.log('smtp message id:', row?.provider_message_id);
    expect(row!.status).toBe('sent');
    expect(row!.provider_message_id).toBeTruthy();
  });
});

describe.skipIf(configured)('email-smtp, live', () => {
  it('is skipped without SMTP_HOST, SMTP_FROM and LIVE_EMAIL_TO', () => {
    expect(configured).toBe(false);
  });
});
