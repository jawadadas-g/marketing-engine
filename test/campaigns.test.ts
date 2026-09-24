import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/api/app.js';
import { db } from '../src/db/client.js';
import { resetFake } from '../src/modules/messaging/adapters/fake.js';
import { withTenant } from '../src/db/client.js';
import {
  enqueueRun,
  processBatch,
  runCampaign,
  type BatchJob,
  type RunJob,
} from '../src/modules/campaigns/index.js';
import { TENANT_A, TENANT_B, resetDb, startQueue, teardownDb, tokenFor } from './helpers.js';

const app = createApp();

// US numbers: no region rules, so no sending window makes a test depend on the
// hour it runs at. Campaign sends are evaluated at the real clock.
const PHONES = Array.from({ length: 12 }, (_, i) => `+1415555${String(100 + i).padStart(4, '0')}`);

let tokenA: string;
let tokenB: string;

function request(path: string, init: RequestInit = {}, token: string = tokenA) {
  return app.fetch(
    new Request(`http://engine.test${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
    }),
  );
}

async function call<T = Record<string, unknown>>(
  method: string,
  path: string,
  body?: unknown,
  token = tokenA,
): Promise<{ status: number; body: T }> {
  const res = await request(
    path,
    {
      method,
      ...(body === undefined
        ? {}
        : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    },
    token,
  );
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}

async function setupChannel(token = tokenA) {
  await call(
    'PUT',
    '/v1/channels/sms',
    { provider: 'fake', sender: 'ACME', unsubscribeText: 'Reply STOP', config: { token: 'good' } },
    token,
  );
  await call('PUT', '/v1/templates/promo', { channel: 'sms', body: 'Hi {{ contact.name }}' }, token);
}

async function contact(phone: string, opts: { consent?: boolean; name?: string; companyId?: string } = {}) {
  const res = await call<{ contact: { id: string } }>('POST', '/v1/contacts', {
    phone,
    name: opts.name ?? phone,
    ...(opts.companyId ? { companyId: opts.companyId } : {}),
  });
  if (opts.consent) {
    await call('POST', '/v1/consent', {
      channel: 'sms',
      address: phone,
      purpose: 'marketing',
      status: 'granted',
      source: 'test',
    });
  }
  return res.body.contact.id;
}

async function staticAudience(contactIds: string[], name = 'list') {
  const res = await call<{ audience: { id: string } }>('POST', '/v1/audiences', { name, kind: 'static' });
  const id = res.body.audience.id;
  if (contactIds.length) await call('POST', `/v1/audiences/${id}/members`, { contactIds });
  return id;
}

async function campaign(audienceId: string, extra: Record<string, unknown> = {}) {
  const res = await call<{ campaign: { id: string } }>('POST', '/v1/campaigns', {
    name: `c-${Math.random()}`,
    audienceId,
    template: 'promo',
    channel: 'sms',
    purpose: 'marketing',
    ...extra,
  });
  if (res.status !== 201) throw new Error(`create campaign: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.campaign.id;
}

type Job = { id: string; name: string; data: RunJob & BatchJob; start_after: Date };

async function createdJobs(name?: string): Promise<Job[]> {
  return db()<Job[]>`
    select id::text, name, data, start_after from pgboss.job
    where state = 'created'
      and ${name ? db()`name = ${name}` : db()`name like 'campaign.%'`}
    order by created_on, id
  `;
}

async function execute(job: Job) {
  await db()`delete from pgboss.job where id = ${job.id}`;
  if (job.name === 'campaign.run') await runCampaign(job.data);
  else await processBatch(job.data);
}

/**
 * Drive the campaign workers by hand, ignoring start_after: take the oldest
 * waiting job, delete it, run its handler. `runs: false` leaves campaign.run
 * jobs alone, so a recurrence can be driven one run at a time.
 */
async function drive(opts: { runs?: boolean } = {}) {
  for (let i = 0; i < 500; i += 1) {
    const jobs = await createdJobs(opts.runs === false ? 'campaign.batch' : undefined);
    if (!jobs[0]) return;
    await execute(jobs[0]);
  }
  throw new Error('drive did not settle');
}

/** Run one scheduled occurrence and every batch it produces. */
async function driveRun(runNo: number) {
  const job = (await createdJobs('campaign.run')).find((j) => j.data.runNo === runNo);
  if (!job) throw new Error(`no campaign.run job for run ${runNo}`);
  await execute(job);
  await drive({ runs: false });
}

async function runsOf(campaignId: string) {
  return (
    await call<{ items: { id: string; runNo: number; status: string; audienceSize: number; queued: number; blocked: number; skipped: number }[] }>(
      'GET',
      `/v1/campaigns/${campaignId}/runs`,
    )
  ).body.items;
}

async function recipients(campaignId: string, runId: string, state?: string) {
  return (
    await call<{ items: { contactId: string; state: string; reason: string | null; messageId: string | null; message: { status: string } | null }[] }>(
      'GET',
      `/v1/campaigns/${campaignId}/runs/${runId}/recipients${state ? `?state=${state}` : ''}`,
    )
  ).body.items;
}

async function status(campaignId: string) {
  return (await call<{ campaign: { status: string } }>('GET', `/v1/campaigns/${campaignId}`)).body.campaign.status;
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
  await setupChannel();
});

describe('contact import', () => {
  const header =
    'phone,email,telegram,name,company_cr,attributes,consent_channels,consent_purpose,consent_source,consent_date';
  const csv = [
    header,
    `${PHONES[0]},,,Amal,,"{""tier"":""gold""}",sms,marketing,signed supply agreement 2026-03-11,2026-03-11`,
    `${PHONES[1]},,,Badr,,,sms,marketing,web form,2026-04-02T09:30:00Z`,
    `${PHONES[2]},,,Chen,,,,,,`,
    `,dana@example.com,,Dana,,,,,,`,
    `,,tg-500,Eli,,,,,,`,
    `not-a-phone,,,Bad,,,,,,`,
  ].join('\n');

  const post = (body: string) =>
    request('/v1/contacts/import', { method: 'POST', headers: { 'Content-Type': 'text/csv' }, body });

  it('records consent only where the row carries evidence, and re-imports update', async () => {
    const first = (await (await post(csv)).json()) as Record<string, unknown>;
    expect(first).toMatchObject({
      rows: 6,
      contactsCreated: 5,
      contactsUpdated: 0,
      consentRecorded: 2,
      rejected: [{ row: 7 }],
    });

    const consent = await db()<{ address: string; source: string; recorded_at: Date }[]>`
      select address, source, recorded_at from consent order by address
    `;
    expect(consent.map((c) => c.address)).toEqual([PHONES[0], PHONES[1]]);
    expect(consent[0]!.source).toBe('signed supply agreement 2026-03-11');
    expect(consent[0]!.recorded_at.toISOString()).toBe('2026-03-11T00:00:00.000Z');

    // Having a number is not consent: marketing to Chen is blocked.
    const sent = await call<{ message: { status: string } }>('POST', '/v1/messages', {
      contact: { phone: PHONES[2] },
      channel: 'sms',
      purpose: 'marketing',
      template: 'promo',
      variables: {},
    });
    expect(sent.body.message.status).toBe('blocked');

    const again = (await (await post(csv)).json()) as Record<string, unknown>;
    expect(again).toMatchObject({ contactsCreated: 0, contactsUpdated: 5 });
    const [count] = await db()<{ n: number }[]>`select count(*)::int as n from contacts`;
    expect(count!.n).toBe(5);

    const amal = await call<{ items: { attributes: Record<string, unknown> }[] }>('GET', '/v1/contacts?q=Amal');
    expect(amal.body.items[0]!.attributes).toEqual({ tier: 'gold' });
  });

  it('rejects a row with partial consent and says which line', async () => {
    const res = (await (
      await post([header, `${PHONES[3]},,,Half,,,sms,marketing,,`].join('\n'))
    ).json()) as { rejected: { row: number; reason: string }[]; contactsCreated: number };
    expect(res.contactsCreated).toBe(0);
    expect(res.rejected).toEqual([{ row: 2, reason: expect.stringContaining('consent needs all') }]);
  });

  it('never merges two stored contacts', async () => {
    await call('POST', '/v1/contacts', { phone: PHONES[0] });
    await call('POST', '/v1/contacts', { email: 'x@example.com' });
    const both = await call<{ error: string; contactIds: string[] }>('POST', '/v1/contacts', {
      phone: PHONES[0],
      email: 'x@example.com',
    });
    expect(both.status).toBe(409);
    expect(both.body.error).toBe('contact_ambiguous');
    expect(both.body.contactIds).toHaveLength(2);
  });
});

describe('audiences', () => {
  it('previews who is sendable and why the rest are not', async () => {
    const ok = await contact(PHONES[0]!, { consent: true });
    const suppressed = await contact(PHONES[1]!, { consent: true });
    const unconsented = await contact(PHONES[2]!);
    await call('POST', '/v1/suppression', { channel: 'sms', address: PHONES[1], reason: 'complaint' });
    const audience = await staticAudience([ok, suppressed, unconsented]);

    const preview = await call<{
      total: number;
      sendable: number;
      contacts: { id: string; allowed: boolean; channel: string | null; reason: string | null }[];
    }>('POST', `/v1/audiences/${audience}/preview?limit=20&purpose=marketing&channel=sms`);

    expect(preview.body.total).toBe(3);
    expect(preview.body.sendable).toBe(1);
    const byId = new Map(preview.body.contacts.map((c) => [c.id, c]));
    expect(byId.get(ok)).toMatchObject({ allowed: true, channel: 'sms' });
    expect(byId.get(suppressed)).toMatchObject({ allowed: false, reason: 'suppressed' });
    expect(byId.get(unconsented)).toMatchObject({ allowed: false, reason: 'no_consent' });
  });

  it('adds members from a CSV of addresses', async () => {
    const audience = await staticAudience([]);
    const res = await request(`/v1/audiences/${audience}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/csv' },
      body: ['phone,name', `${PHONES[0]},One`, `${PHONES[1]},Two`, 'nope,Bad'].join('\n'),
    });
    expect(await res.json()).toMatchObject({ added: 2, contactsCreated: 2, rejected: [{ row: 4 }] });
  });
});

describe('campaigns', () => {
  it('runs a one-shot campaign through messaging.send', async () => {
    const ids = [
      await contact(PHONES[0]!, { consent: true, name: 'Amal' }),
      await contact(PHONES[1]!, { consent: true, name: 'Badr' }),
      await contact(PHONES[2]!, { consent: true, name: 'Chen' }),
    ];
    const audience = await staticAudience(ids);
    const id = await campaign(audience, { scheduledAt: new Date(Date.now() + 2000).toISOString() });

    const scheduled = await call<{ campaign: { status: string; nextRunAt: string } }>(
      'POST',
      `/v1/campaigns/${id}/schedule`,
    );
    expect(scheduled.body.campaign.status).toBe('scheduled');

    const [job] = await createdJobs('campaign.run');
    expect(job!.data).toMatchObject({ campaignId: id, runNo: 1 });
    const delay = job!.start_after.getTime() - Date.now();
    expect(delay).toBeGreaterThan(0);
    expect(delay).toBeLessThanOrEqual(3000);

    await drive();

    const runs = await runsOf(id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'done', audienceSize: 3, queued: 3, blocked: 0, skipped: 0 });
    expect(await status(id)).toBe('done');

    const got = await recipients(id, runs[0]!.id);
    expect(got.map((r) => r.state)).toEqual(['queued', 'queued', 'queued']);
    expect(got.every((r) => r.message?.status === 'queued')).toBe(true);

    const messages = await db()<{ campaign_run_id: string; body: string }[]>`
      select campaign_run_id, body from messages order by body
    `;
    expect(messages).toHaveLength(3);
    expect(messages.every((m) => m.campaign_run_id === runs[0]!.id)).toBe(true);
    // The contact is in the template's variables.
    expect(messages[0]!.body).toBe('Hi Amal\nReply STOP');

    const [finished] = await db()<{ payload: Record<string, number> }[]>`
      select payload from events where type = 'campaign.run.finished'
    `;
    expect(finished!.payload).toMatchObject({ audienceSize: 3, queued: 3, blocked: 0, skipped: 0 });
  });

  it('records a blocked recipient with its reason and sends nothing to it', async () => {
    const ids = [
      await contact(PHONES[0]!, { consent: true }),
      await contact(PHONES[1]!, { consent: true }),
      await contact(PHONES[2]!),
    ];
    const id = await campaign(await staticAudience(ids));
    await call('POST', `/v1/campaigns/${id}/schedule`);
    await drive();

    const [run] = await runsOf(id);
    expect(run).toMatchObject({ status: 'done', queued: 2, blocked: 1 });
    expect(await status(id)).toBe('done');

    const [blocked] = await recipients(id, run!.id, 'blocked');
    expect(blocked).toMatchObject({ contactId: ids[2], reason: 'no_consent' });
    expect(blocked!.message?.status).toBe('blocked');

    const queued = await db()`select id from messages where status = 'queued'`;
    expect(queued).toHaveLength(2);
    const sendJobs = await db()`select id from pgboss.job where name = 'message.send'`;
    expect(sendJobs).toHaveLength(2);
  });

  it('snapshots the audience per run: a new member is in the next run only', async () => {
    const a = await contact(PHONES[0]!, { consent: true });
    const b = await contact(PHONES[1]!, { consent: true });
    const audience = await staticAudience([a, b]);
    const id = await campaign(audience, { recurrence: { cron: '0 10 * * 1' } });
    await call('POST', `/v1/campaigns/${id}/schedule`);

    await driveRun(1);
    expect(await status(id)).toBe('scheduled');

    const c = await contact(PHONES[2]!, { consent: true });
    await call('POST', `/v1/audiences/${audience}/members`, { contactIds: [c] });

    await driveRun(2);

    const runs = (await runsOf(id)).sort((x, y) => x.runNo - y.runNo);
    const first = await recipients(id, runs[0]!.id);
    const second = await recipients(id, runs[1]!.id);
    expect(first.map((r) => r.contactId)).not.toContain(c);
    expect(first).toHaveLength(2);
    expect(second.map((r) => r.contactId)).toContain(c);

    // Run 1 sent to its two, once each, and nothing more.
    const [perRun] = await db()<{ n: number }[]>`
      select count(*)::int as n from messages where campaign_run_id = ${runs[0]!.id}
    `;
    expect(perRun!.n).toBe(2);
  });

  it('ends a recurrence at maxRuns, and at endsAt', async () => {
    const audience = await staticAudience([await contact(PHONES[0]!, { consent: true })]);

    const capped = await campaign(audience, { recurrence: { cron: '*/1 * * * *', maxRuns: 2 } });
    await call('POST', `/v1/campaigns/${capped}/schedule`);
    await drive();

    expect(await runsOf(capped)).toHaveLength(2);
    expect(await status(capped)).toBe('done');
    expect(await createdJobs('campaign.run')).toHaveLength(0);

    const ending = await campaign(audience, {
      recurrence: { cron: '*/1 * * * *', endsAt: new Date(Date.now() + 3_600_000).toISOString() },
    });
    await call('POST', `/v1/campaigns/${ending}/schedule`);
    // Time passes: by the time run 1 starts, endsAt is behind it.
    await db()`
      update campaigns
      set recurrence = jsonb_set(recurrence, '{endsAt}', to_jsonb(${new Date(Date.now() - 1000).toISOString()}::text))
      where id = ${ending}
    `;
    await drive();
    expect(await runsOf(ending)).toHaveLength(1);
    expect(await status(ending)).toBe('done');
  });

  it('throttles: one tenth of a minute per batch, ten seconds apart', async () => {
    const ids: string[] = [];
    for (const phone of PHONES.slice(0, 10)) ids.push(await contact(phone, { consent: true }));
    const id = await campaign(await staticAudience(ids), { throttlePerMinute: 6 });
    await call('POST', `/v1/campaigns/${id}/schedule`);

    await execute((await createdJobs('campaign.run'))[0]!);
    const [firstBatch] = await createdJobs('campaign.batch');
    await execute(firstBatch!);

    const [run] = await runsOf(id);
    expect(run!.queued).toBe(1);
    const [next] = await createdJobs('campaign.batch');
    expect(next).toBeDefined();
    expect(next!.start_after.getTime() - Date.now()).toBeGreaterThan(5000);

    await drive();
    const [done] = await runsOf(id);
    expect(done).toMatchObject({ status: 'done', queued: 10 });
  });

  it('pauses, resumes, and cancels without recalling what went', async () => {
    const ids: string[] = [];
    for (const phone of PHONES.slice(0, 3)) ids.push(await contact(phone, { consent: true }));
    const audience = await staticAudience(ids);

    const id = await campaign(audience, { throttlePerMinute: 6 });
    await call('POST', `/v1/campaigns/${id}/schedule`);
    await execute((await createdJobs('campaign.run'))[0]!);
    await execute((await createdJobs('campaign.batch'))[0]!);

    expect((await call('POST', `/v1/campaigns/${id}/pause`)).status).toBe(200);
    // The batch already waiting runs, sends nothing and queues nothing.
    await drive({ runs: false });
    let [run] = await runsOf(id);
    expect(run!.queued).toBe(1);
    expect(await recipients(id, run!.id, 'pending')).toHaveLength(2);
    expect(await createdJobs('campaign.batch')).toHaveLength(0);

    expect((await call('POST', `/v1/campaigns/${id}/resume`)).status).toBe(200);
    await drive();
    [run] = await runsOf(id);
    expect(run).toMatchObject({ status: 'done', queued: 3 });
    expect(await status(id)).toBe('done');

    const other = await campaign(audience, { throttlePerMinute: 6 });
    await call('POST', `/v1/campaigns/${other}/schedule`);
    await execute((await createdJobs('campaign.run'))[0]!);
    await execute((await createdJobs('campaign.batch'))[0]!);

    expect((await call('POST', `/v1/campaigns/${other}/cancel`)).status).toBe(200);
    await drive();
    const [cancelled] = await runsOf(other);
    expect(cancelled).toMatchObject({ status: 'cancelled', queued: 1, skipped: 2 });
    const skipped = await recipients(other, cancelled!.id, 'skipped');
    expect(skipped.map((r) => r.reason)).toEqual(['cancelled', 'cancelled']);
    const [sent] = await recipients(other, cancelled!.id, 'queued');
    expect(sent!.message?.status).toBe('queued');
    expect(await status(other)).toBe('cancelled');
  });

  it('resolves a search audience at run time, dropping companies that joined', async () => {
    const companyIds: string[] = [];
    for (const [i, name] of ['Riyadh Diesel', 'Jeddah Diesel'].entries()) {
      const created = await call<{ company: { id: string } }>('POST', '/v1/companies', {
        name,
        country: 'SA',
        identifiers: [{ type: 'cr', value: `101020000${i}` }],
        source: { type: 'api' },
      });
      const companyId = created.body.company.id;
      await call('PUT', `/v1/companies/${companyId}/profile`, { buys: ['diesel'] });
      companyIds.push(companyId);
    }
    await contact(PHONES[0]!, { consent: true, companyId: companyIds[0]! });
    await contact(PHONES[1]!, { consent: true, companyId: companyIds[1]! });
    await contact(PHONES[2]!, { consent: true });

    const audience = await call<{ audience: { id: string } }>('POST', '/v1/audiences', {
      name: 'diesel buyers',
      kind: 'search',
      definition: { finderQuery: { buys: ['diesel'] }, contactFilter: { hasChannel: ['sms'] } },
    });
    const audienceId = audience.body.audience.id;

    const preview = await call<{ total: number }>('POST', `/v1/audiences/${audienceId}/preview`);
    expect(preview.body.total).toBe(2);

    const id = await campaign(audienceId, { recurrence: { cron: '0 10 * * 1' } });
    await call('POST', `/v1/campaigns/${id}/schedule`);
    await driveRun(1);

    await db()`update companies set on_platform_ref = 'mkt-1', on_platform_at = now() where id = ${companyIds[0]!}`;
    await driveRun(2);

    const runs = (await runsOf(id)).sort((x, y) => x.runNo - y.runNo);
    expect(runs.map((r) => r.audienceSize)).toEqual([2, 1]);
  });

  it('guards: nobody sendable, too many running, a time in the past', async () => {
    const unconsented = await staticAudience([await contact(PHONES[0]!)], 'nobody');
    const empty = await campaign(unconsented);
    const refused = await call<{ error: string }>('POST', `/v1/campaigns/${empty}/schedule`);
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe('audience_empty');

    const audience = await staticAudience([await contact(PHONES[1]!, { consent: true })], 'some');
    for (let i = 0; i < 5; i += 1) {
      const running = await campaign(audience);
      await db()`update campaigns set status = 'running' where id = ${running}`;
    }
    const sixth = await campaign(audience);
    const full = await call<{ error: string }>('POST', `/v1/campaigns/${sixth}/schedule`);
    expect(full.status).toBe(409);
    expect(full.body.error).toBe('too_many_running');

    const past = await call<{ error: string }>('POST', '/v1/campaigns', {
      name: 'late',
      audienceId: audience,
      template: 'promo',
      channel: 'sms',
      purpose: 'marketing',
      scheduledAt: new Date(Date.now() - 60_000).toISOString(),
    });
    expect(past.status).toBe(400);
    expect(past.body.error).toBe('scheduled_at_past');
  });

  it('creates one run when campaign.run is delivered twice', async () => {
    const ids = [await contact(PHONES[0]!, { consent: true }), await contact(PHONES[1]!, { consent: true })];
    const id = await campaign(await staticAudience(ids));
    await call('POST', `/v1/campaigns/${id}/schedule`);

    // Asking for the same run again while it waits queues nothing more.
    await withTenant(TENANT_A, (tx) =>
      enqueueRun(tx, { id, tenant_id: TENANT_A }, 1, new Date(Date.now() + 60_000)),
    );
    expect(await createdJobs('campaign.run')).toHaveLength(1);

    const job = { tenantId: TENANT_A, campaignId: id, runNo: 1 };
    await runCampaign(job);
    await runCampaign(job);

    const runs = await db()`select id from campaign_runs where campaign_id = ${id}`;
    expect(runs).toHaveLength(1);
    const [count] = await db()<{ n: number }[]>`select count(*)::int as n from campaign_recipients`;
    expect(count!.n).toBe(2);

    // And a second schedule is refused rather than queued twice.
    expect((await call('POST', `/v1/campaigns/${id}/schedule`)).status).toBe(409);
  });

  it("keeps tenant A's contacts, audiences, campaigns and runs from tenant B", async () => {
    const contactId = await contact(PHONES[0]!, { consent: true });
    const audience = await staticAudience([contactId]);
    const id = await campaign(audience);
    await call('POST', `/v1/campaigns/${id}/schedule`);
    await drive();
    const [run] = await runsOf(id);

    expect((await call('GET', `/v1/contacts/${contactId}`, undefined, tokenB)).status).toBe(404);
    expect((await call('GET', `/v1/audiences/${audience}`, undefined, tokenB)).status).toBe(404);
    expect((await call('GET', `/v1/campaigns/${id}`, undefined, tokenB)).status).toBe(404);
    expect((await call('GET', `/v1/campaigns/${id}/runs`, undefined, tokenB)).status).toBe(404);
    expect(
      (await call('GET', `/v1/campaigns/${id}/runs/${run!.id}/recipients`, undefined, tokenB)).status,
    ).toBe(404);

    const lists = await Promise.all(
      ['/v1/contacts', '/v1/audiences', '/v1/campaigns'].map((path) =>
        call<{ items: unknown[] }>('GET', path, undefined, tokenB),
      ),
    );
    expect(lists.map((l) => l.body.items.length)).toEqual([0, 0, 0]);

    // B cannot aim a campaign at A's audience either.
    await setupChannel(tokenB);
    const aimed = await call('POST', '/v1/campaigns', {
      name: 'x',
      audienceId: audience,
      template: 'promo',
      channel: 'sms',
      purpose: 'marketing',
    }, tokenB);
    expect(aimed.status).toBe(404);
  });

  it('shows the operator every campaign, its runs and recipients', async () => {
    const ids = [await contact(PHONES[0]!, { consent: true }), await contact(PHONES[1]!)];
    const id = await campaign(await staticAudience(ids), { throttlePerMinute: 6 });
    await call('POST', `/v1/campaigns/${id}/schedule`);
    await execute((await createdJobs('campaign.run'))[0]!);
    await execute((await createdJobs('campaign.batch'))[0]!);

    const internal = async (path: string) => {
      const res = await app.fetch(
        new Request(`http://engine.test${path}`, {
          headers: { 'X-Internal-Token': process.env.INTERNAL_TOKEN! },
        }),
      );
      return (await res.json()) as Record<string, any>;
    };

    // Mid-run: one recipient done, one pending.
    const overview = await internal('/internal/overview?window=24h');
    expect(overview['campaigns']).toEqual({
      scheduled: 0,
      running: 1,
      recipientsPending: 1,
      sentInWindow: expect.any(Number),
      blockedInWindow: expect.any(Number),
    });
    expect(overview['campaigns'].sentInWindow + overview['campaigns'].blockedInWindow).toBe(1);

    const list = await internal(`/internal/campaigns?tenantId=${TENANT_A}&status=running`);
    expect(list['items']).toHaveLength(1);
    expect(list['items'][0]).toMatchObject({ id, tenantName: 'Tenant A', status: 'running' });
    expect(list['items'][0].lastRun).toMatchObject({ audienceSize: 2, pending: 1 });

    const detail = await internal(`/internal/campaigns/${id}`);
    expect(detail['runs']).toHaveLength(1);
    const runId = detail['runs'][0].id as string;

    const pending = await internal(`/internal/campaigns/${id}/runs/${runId}/recipients?state=pending`);
    expect(pending['items']).toHaveLength(1);
  });
});
