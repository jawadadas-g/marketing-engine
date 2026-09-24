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
import { processBatch, runCampaign, type BatchJob, type RunJob } from '../src/modules/campaigns/index.js';

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
  'contact.upserted',
  'campaign.scheduled',
  'campaign.run.started',
  'campaign.run.finished',
];

const PHONE = '+966501234567';

type Delivered = { type: string; verified: boolean; payload: unknown };
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

  await campaignLeg(token);

  await drainWebhooks();
  ok(`the marketplace heard ${heard.length} events, all verified`);

  const finished = heard.filter((h) => h.type === 'campaign.run.finished');
  if (finished.length !== 1) fail('expected one campaign.run.finished on the webhook', finished);
  const counts = finished[0]!.payload as { audienceSize: number; queued: number; blocked: number };
  if (counts.audienceSize !== 3 || counts.queued !== 3 || counts.blocked !== 0) {
    fail('campaign.run.finished counts are wrong', counts);
  }
  ok('campaign.run.finished reached the webhook with 3 of 3 queued');
}

/**
 * Contacts with consent evidence, an audience, a campaign scheduled a second
 * out, and the workers driven by hand until the run is done.
 */
async function campaignLeg(token: string): Promise<void> {
  // US numbers carry no regional sending window, so this leg does not depend
  // on the hour it runs at.
  const phones = ['+14155550101', '+14155550102', '+14155550103'];
  const csv = [
    'phone,email,telegram,name,company_cr,attributes,consent_channels,consent_purpose,consent_source,consent_date',
    ...phones.map((p, i) => `${p},,,Buyer ${i + 1},,,sms,marketing,signed supply agreement,2026-03-11`),
  ].join('\n');
  const imported = (await callRaw('POST', '/v1/contacts/import', csv, {
    token,
    contentType: 'text/csv',
    expect: 200,
  })) as { contactsCreated: number; consentRecorded: number };
  if (imported.contactsCreated !== 3 || imported.consentRecorded !== 3) {
    fail('expected three contacts with consent', imported);
  }
  ok('imported three contacts with consent evidence');

  const audience = (await call('POST', '/v1/audiences', {
    token,
    body: { name: 'e2e buyers', kind: 'static' },
    expect: 201,
  })) as { audience: { id: string } };
  await callRaw('POST', `/v1/audiences/${audience.audience.id}/members`, ['phone', ...phones].join('\n'), {
    token,
    contentType: 'text/csv',
    expect: 200,
  });
  const preview = (await call('POST', `/v1/audiences/${audience.audience.id}/preview`, {
    token,
    expect: 200,
  })) as { total: number; sendable: number };
  if (preview.total !== 3 || preview.sendable !== 3) fail('preview should show 3 of 3 sendable', preview);
  ok('built an audience and previewed it: 3 of 3 sendable');

  const created = (await call('POST', '/v1/campaigns', {
    token,
    body: {
      name: 'e2e launch',
      audienceId: audience.audience.id,
      template: 'hello',
      channel: 'sms',
      purpose: 'marketing',
      variables: { name: 'there' },
      scheduledAt: new Date(Date.now() + 1000).toISOString(),
    },
    expect: 201,
  })) as { campaign: { id: string } };
  const campaignId = created.campaign.id;
  await call('POST', `/v1/campaigns/${campaignId}/schedule`, { token, expect: 200 });
  ok('scheduled a campaign one second out');

  await driveCampaignJobs();
  const campaign = (await call('GET', `/v1/campaigns/${campaignId}`, { token, expect: 200 })) as {
    campaign: { status: string; lastRun: { id: string; status: string; queued: number } };
  };
  if (campaign.campaign.status !== 'done' || campaign.campaign.lastRun.queued !== 3) {
    fail('the campaign did not finish with 3 queued', campaign);
  }

  const recipients = (await call(
    'GET',
    `/v1/campaigns/${campaignId}/runs/${campaign.campaign.lastRun.id}/recipients`,
    { token, expect: 200 },
  )) as { items: { messageId: string | null; state: string }[] };
  const messageIds = recipients.items.flatMap((r) => (r.messageId ? [r.messageId] : []));
  if (messageIds.length !== 3) fail('expected three campaign messages', recipients);
  for (const id of messageIds) await processSend(id);
  ok('drove the workers: one run, 3 messages sent to the provider');
}

/** No workers are running, so campaign jobs are taken and run here, ignoring start_after. */
async function driveCampaignJobs(): Promise<void> {
  for (let pass = 0; pass < 100; pass += 1) {
    const [job] = await db()<{ id: string; name: string; data: RunJob & BatchJob }[]>`
      select id::text, name, data from pgboss.job
      where name like 'campaign.%' and state = 'created'
      order by created_on, id
      limit 1
    `;
    if (!job) return;
    await db()`delete from pgboss.job where id = ${job.id}`;
    if (job.name === 'campaign.run') await runCampaign(job.data);
    else await processBatch(job.data);
  }
  fail('campaign jobs did not settle');
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
      const event = JSON.parse(body) as { type: string; data?: unknown };
      heard.push({ type: event.type, verified, payload: event.data });
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
  await db()`delete from pgboss.job where name like 'webhook.%' or name like 'campaign.%'`;
}

await main();
