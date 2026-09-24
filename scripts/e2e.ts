/**
 * The done-when, as a script: everything a marketplace client does, through
 * the HTTP API alone, with no access to the engine's database.
 *
 * Runs the real app against DATABASE_URL_TEST, stands up a listener as the
 * marketplace's webhook receiver, and walks the whole journey. Exits non-zero
 * on the first thing that does not hold.
 */
import { createServer, type Server } from 'node:http';
import { serve } from '@hono/node-server';
import { SignJWT } from 'jose';
import { createApp } from '../src/api/app.js';
import { closeDb, db } from '../src/db/client.js';
import { migrate } from '../src/db/migrate.js';
import { env, resetEnv } from '../src/env.js';
import { startJobs, stopJobs } from '../src/jobs/index.js';
import { deliver, fanOut, verifyPayload } from '../src/modules/webhooks/index.js';
import { processSend } from '../src/modules/messaging/worker.js';

const REQUIRED_EVENTS = [
  'tenant.created',
  'channel.configured',
  'consent.granted',
  'company.created',
  'invite.sent',
  'invite.accepted',
  'promo.reserved',
  'promo.settled',
  'message.queued',
  'message.sent',
];

const PHONE = '+966501234567';

type Delivered = { type: string; verified: boolean };
const heard: Delivered[] = [];

let step = 0;
function ok(what: string): void {
  step += 1;
  console.log(`  ${String(step).padStart(2, ' ')}. ${what}`);
}

function fail(what: string, detail?: unknown): never {
  console.error(`\n  FAILED: ${what}`);
  if (detail !== undefined) console.error(`  ${JSON.stringify(detail, null, 2)}`);
  process.exit(1);
}

async function main(): Promise<void> {
  process.env.DATABASE_URL = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;
  // The listener is on loopback http, as a local marketplace would be.
  process.env.PUBLIC_BASE_URL = 'http://127.0.0.1:3999';
  process.env.MARKETPLACE_SIGNUP_URL ??= 'https://marketplace.test/signup';
  resetEnv();

  console.log('\nmarketing-engine end to end\n');

  await migrate();
  await reset();
  await startJobs({ registerWorkers: false });

  const engine = serve({ fetch: createApp().fetch, port: 3999, hostname: '127.0.0.1' });
  const listener = await startListener();

  try {
    await journey(listener.url);
  } finally {
    await new Promise<void>((resolve) => engine.close(() => resolve()));
    await listener.close();
    await stopJobs();
    await closeDb();
  }

  const missing = REQUIRED_EVENTS.filter((type) => !heard.some((h) => h.type === type));
  if (missing.length) fail(`the marketplace never heard: ${missing.join(', ')}`, heard.map((h) => h.type));

  const unverified = heard.filter((h) => !h.verified);
  if (unverified.length) fail('some deliveries did not verify', unverified);

  console.log(`\n  all ${REQUIRED_EVENTS.length} required events delivered and verified\n`);
}

const BASE = 'http://127.0.0.1:3999';
let secret = '';

async function journey(listenerUrl: string): Promise<void> {
  // 1. The marketplace provisions a tenant with its own key.
  const provisioned = await call('POST', '/internal/tenants', {
    body: { name: 'Acme Supplies', externalRef: 'mkt-acme' },
    internal: true,
    expect: 201,
  });
  const tenantId = (provisioned as { tenantId: string }).tenantId;
  ok(`provisioned tenant ${tenantId}`);

  // 2. The marketplace mints its own tenant token; the engine never does.
  const token = await new SignJWT({ tenant_id: tenantId, sub: 'mkt-acme' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(new TextEncoder().encode(env().JWT_SECRET));
  ok('minted a tenant JWT with the shared secret');

  // 3. Register the listener, so everything after this is heard about.
  const hook = (await call('POST', '/v1/webhooks', {
    token,
    body: { url: listenerUrl },
    expect: 201,
  })) as { secret: string };
  secret = hook.secret;
  ok('registered a webhook endpoint');

  await call('PUT', '/v1/channels/sms', {
    token,
    body: { provider: 'fake', sender: 'ACME', unsubscribeText: 'Reply STOP', config: { token: 'good' } },
    expect: 200,
  });
  ok('configured the SMS channel');

  await call('PUT', '/v1/templates/hello', {
    token,
    body: { channel: 'sms', body: 'Hello {{ name }}' },
    expect: 200,
  });
  await call('PUT', '/v1/templates/invite', {
    token,
    body: { channel: 'sms', body: 'Join us: {{ invite_url }}' },
    expect: 200,
  });
  ok('saved two templates');

  await call('POST', '/v1/consent', {
    token,
    body: { channel: 'sms', address: PHONE, purpose: 'marketing', status: 'granted', source: 'e2e' },
    expect: 201,
  });
  ok('recorded consent');

  const csv = [
    'name,country,cr,vat,domain,phone,email,relationship,tags,buys,sells,sector,city',
    'Riyadh Diesel Co,SA,1010200001,,,,,prospect,,diesel,,energy,Riyadh',
    'Jeddah Diesel Co,SA,1010200002,,,,,prospect,,diesel,,energy,Jeddah',
    'Riyadh LPG Co,SA,1010200003,,,,,prospect,,lpg,,energy,Riyadh',
  ].join('\n');
  const imported = (await callRaw('POST', '/v1/companies/import', csv, {
    token,
    contentType: 'text/csv',
    expect: 200,
  })) as { created: number };
  if (imported.created !== 3) fail('expected three companies imported', imported);
  ok('imported three companies with profiles');

  const found = (await call('POST', '/v1/discovery/search', {
    token,
    body: { buys: ['diesel'] },
    expect: 200,
  })) as { finderRunId: number; candidates: { company: { id: string; name: string } }[] };
  if (found.candidates.length !== 2) fail('expected two diesel buyers', found.candidates.length);
  ok(`searched and found ${found.candidates.length} diesel buyers`);

  const target = found.candidates[0]!.company;
  const invited = (await call('POST', `/v1/companies/${target.id}/invite`, {
    token,
    body: {
      contact: { phone: PHONE },
      channel: 'sms',
      template: 'invite',
      finderRunId: found.finderRunId,
    },
    expect: 202,
  })) as { invite: { token: string }; message: { id: string } };
  ok(`invited ${target.name}`);

  const redirect = await fetch(`${BASE}/i/${invited.invite.token}`, { redirect: 'manual' });
  if (redirect.status !== 302) fail('invite link did not redirect', redirect.status);
  ok('followed the invite link to signup');

  await call('POST', '/internal/invites/accept', {
    body: { token: invited.invite.token, ref: 'mkt-company-77' },
    internal: true,
    expect: 200,
  });
  ok('the marketplace reported the signup');

  const after = (await call('POST', '/v1/discovery/search', {
    token,
    body: { buys: ['diesel'] },
    expect: 200,
  })) as { candidates: unknown[] };
  if (after.candidates.length !== 1) fail('the joined company is still in results', after.candidates.length);
  ok('the joined company dropped out of discovery');

  await call('POST', '/v1/promocodes', {
    token,
    body: {
      code: 'E2E10',
      currency: 'SAR',
      discount: { type: 'percent', value: 1000, maxDiscount: 5000 },
      funders: [
        { party: 'platform', share: 0.6 },
        { party: `tenant:${tenantId}`, share: 0.4 },
      ],
    },
    expect: 201,
  });
  ok('created a promocode');

  const cart = { currency: 'SAR', subtotal: 80000, items: [{ sku: 'lpg', qty: 1, unitPrice: 80000 }] };
  const checked = (await call('POST', '/v1/promocodes/validate', {
    token,
    body: { code: 'E2E10', buyerRef: 'cust-1', cart },
    expect: 200,
  })) as { valid: boolean; discountAmount: number };
  if (!checked.valid || checked.discountAmount !== 5000) fail('validate did not discount 5000', checked);
  ok('validated the code at the cart');

  const reserved = (await call('POST', '/v1/redemptions', {
    token,
    body: { code: 'E2E10', buyerRef: 'cust-1', cart, orderRef: 'order-e2e-1' },
    idempotencyKey: 'e2e-reserve-1',
    expect: 201,
  })) as { redemption: { id: string } };
  ok('reserved the discount');

  await call('POST', `/v1/redemptions/${reserved.redemption.id}/settle`, {
    token,
    body: {},
    idempotencyKey: 'e2e-settle-1',
    expect: 200,
  });
  ok('settled on order completion');

  const reconciled = (await call('GET', '/v1/promocodes/reconcile', { token, expect: 200 })) as {
    reconciliation: { settled: { agrees: boolean }; outstanding: { agrees: boolean } }[];
  };
  const sar = reconciled.reconciliation[0];
  if (!sar?.settled.agrees || !sar.outstanding.agrees) fail('reconcile disagrees', reconciled);
  ok('reconcile agrees: spend equals settlement');

  const sent = (await call('POST', '/v1/messages', {
    token,
    body: {
      contact: { phone: PHONE },
      channel: 'sms',
      purpose: 'transactional',
      template: 'hello',
      variables: { name: 'Sam' },
    },
    expect: 202,
  })) as { message: { id: string } };
  await processSend(sent.message.id);
  ok('sent one message and the worker delivered it to the provider');

  await drainWebhooks();
  ok(`the marketplace heard ${heard.length} events, all verified`);
}

/** No workers are running, so the queue is drained here, in order. */
async function drainWebhooks(): Promise<void> {
  for (let pass = 0; pass < 20; pass += 1) {
    const events = await db()<{ id: string }[]>`
      select e.id from events e
      where not exists (select 1 from webhook_deliveries d where d.event_id = e.id)
      order by e.id
    `;
    for (const event of events) await fanOut(event.id);

    const pending = await db()<{ id: string }[]>`
      select id from webhook_deliveries where status = 'pending' order by id
    `;
    if (events.length === 0 && pending.length === 0) return;
    for (const delivery of pending) await deliver(delivery.id);
  }
}

type CallOptions = {
  token?: string;
  body?: unknown;
  internal?: boolean;
  idempotencyKey?: string;
  expect: number;
};

async function call(method: string, path: string, opts: CallOptions): Promise<unknown> {
  return callRaw(method, path, opts.body === undefined ? undefined : JSON.stringify(opts.body), {
    ...opts,
    contentType: 'application/json',
  });
}

async function callRaw(
  method: string,
  path: string,
  body: string | undefined,
  opts: CallOptions & { contentType: string },
): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': opts.contentType } : {}),
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.internal ? { 'X-Internal-Token': env().INTERNAL_TOKEN } : {}),
      ...(opts.idempotencyKey ? { 'Idempotency-Key': opts.idempotencyKey } : {}),
    },
    ...(body !== undefined ? { body } : {}),
  });

  const text = await res.text();
  if (res.status !== opts.expect) {
    fail(`${method} ${path} answered ${res.status}, expected ${opts.expect}`, text.slice(0, 500));
  }
  return text ? JSON.parse(text) : null;
}

async function startListener(): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const headers = req.headers as Record<string, string>;
      const verified = verifyPayload({
        secret,
        id: headers['webhook-id'] ?? '',
        timestamp: Number(headers['webhook-timestamp']),
        body,
        signature: headers['webhook-signature'] ?? '',
      });
      heard.push({ type: (JSON.parse(body) as { type: string }).type, verified });
      res.writeHead(200).end();
    });
  });

  await new Promise<void>((resolve) => server.listen(4999, '127.0.0.1', resolve));
  return {
    url: 'http://127.0.0.1:4999/hook',
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function reset(): Promise<void> {
  await db()`
    truncate idempotency_keys, events, consent, suppression, messages, templates,
             tenant_channel_configs, tenant_company, company_sources,
             company_identifiers, company_profiles, invites, finder_runs,
             companies, ledger_entries, redemptions, promocodes,
             webhook_deliveries, webhook_endpoints, campaign_recipients,
             campaign_runs, campaigns, audience_members, audiences, contacts
             restart identity cascade
  `;
  await db()`delete from tenants`;
  await db()`delete from rules where scope = 'tenant'`;
  await db()`delete from pgboss.job where name like 'webhook.%'`;
}

await main();
