/**
 * Brief 12: quiet hours defer campaign recipients rather than dropping them,
 * and the sweep recovers runs whose job chain died. Jobs are driven by hand
 * and every batch runs at a pinned clock.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/api/app.js';
import { db } from '../src/db/client.js';
import { resetFake } from '../src/modules/messaging/adapters/fake.js';
import {
  processBatch,
  runCampaign,
  sweepRuns,
  windowStats,
  type BatchJob,
  type RunJob,
} from '../src/modules/campaigns/index.js';
import { TENANT_A, TENANT_B, resetDb, startQueue, teardownDb, tokenFor } from './helpers.js';

const app = createApp();

// Saudi numbers: the SA region rule denies marketing SMS outside 09:00-21:00
// Riyadh (UTC+3). Dates are in the future so that `deferred`, which the API
// counts against the database's real clock, still sees them as waiting.
const sa = (i: number) => `+9665012345${String(i).padStart(2, '0')}`;
const RIYADH = (day: number, hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(2027, 2, day, h! - 3, m!));
};
const AT_2058 = RIYADH(1, '20:58');
const AT_2100 = RIYADH(1, '21:00');
const AT_2200 = RIYADH(1, '22:00');
const AT_2300 = RIYADH(1, '23:00');
const NEXT_0900 = RIYADH(2, '09:00');
const AT_1000 = RIYADH(1, '10:00');

let tokenA: string;
let tokenB: string;

async function call<T = Record<string, any>>(method: string, path: string, body?: unknown, token = tokenA) {
  const res = await app.fetch(
    new Request(`http://engine.test${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}

async function setup(token = tokenA) {
  await call('PUT', '/v1/channels/sms', {
    provider: 'fake', sender: 'ACME', unsubscribeText: 'Reply STOP', config: { token: 'good' },
  }, token);
  await call('PUT', '/v1/templates/promo', { channel: 'sms', body: 'Hi {{ contact.name }}' }, token);
}

/** Contacts straight into the tables, for volume. Consent where asked. */
async function seedContacts(tenantId: string, phones: string[], consent = true): Promise<string[]> {
  const rows = await db()<{ id: string }[]>`
    insert into contacts (tenant_id, phone, name)
    select ${tenantId}, p, p from unnest(${phones}::text[]) as p
    returning id
  `;
  if (consent) {
    await db()`
      insert into consent (tenant_id, channel, address, purpose, status, source)
      select ${tenantId}, 'sms', p, 'marketing', 'granted', 'test' from unnest(${phones}::text[]) as p
    `;
  }
  return rows.map((r) => r.id);
}

async function campaignFor(
  contactIds: string[],
  extra: Record<string, unknown> = {},
  token = tokenA,
): Promise<string> {
  const audience = await call<{ audience: { id: string } }>('POST', '/v1/audiences', {
    name: `a-${Math.random()}`, kind: 'static',
  }, token);
  await call('POST', `/v1/audiences/${audience.body.audience.id}/members`, { contactIds }, token);
  const created = await call<{ campaign: { id: string } }>('POST', '/v1/campaigns', {
    name: `c-${Math.random()}`,
    audienceId: audience.body.audience.id,
    template: 'promo',
    channel: 'sms',
    purpose: 'marketing',
    ...extra,
  }, token);
  if (created.status !== 201) throw new Error(JSON.stringify(created.body));
  const id = created.body.campaign.id;
  const scheduled = await call('POST', `/v1/campaigns/${id}/schedule`, undefined, token);
  if (scheduled.status !== 200) throw new Error(JSON.stringify(scheduled.body));
  return id;
}

type Job = { id: string; name: string; data: RunJob & BatchJob; start_after: Date };

async function jobs(name: string): Promise<Job[]> {
  return db()<Job[]>`
    select id::text, name, data, start_after from pgboss.job
    where name = ${name} and state = 'created' order by created_on, id
  `;
}

/** Run the waiting campaign.run job; return the batch job for the run it opened. */
async function expand(): Promise<BatchJob> {
  const [job] = await jobs('campaign.run');
  await db()`delete from pgboss.job where id = ${job!.id}`;
  await runCampaign(job!.data);
  const [batch] = await jobs('campaign.batch');
  await db()`delete from pgboss.job where name = 'campaign.batch'`;
  return batch!.data;
}

/** Batches at `now` until the run stops asking for another one straight away. */
async function drain(job: BatchJob, now: Date) {
  let last;
  for (let i = 0; i < 100; i += 1) {
    last = await processBatch(job, { now });
    if (last.state !== 'sent') break;
  }
  await db()`delete from pgboss.job where name = 'campaign.batch'`;
  return last!;
}

async function recipients(runId: string) {
  return db()<{ contact_id: string; state: string; reason: string | null; not_before: Date | null; message_id: string | null }[]>`
    select contact_id, state, reason, not_before, message_id
    from campaign_recipients where run_id = ${runId} order by contact_id
  `;
}

async function campaign(id: string, token = tokenA) {
  return (await call<{ campaign: { status: string; lastRun: Record<string, any> } }>('GET', `/v1/campaigns/${id}`, undefined, token)).body.campaign;
}

beforeAll(async () => {
  await resetDb();
  await startQueue();
  tokenA = await tokenFor(TENANT_A);
  tokenB = await tokenFor(TENANT_B);
});

afterAll(async () => {
  await db()`drop trigger if exists poison_messages on marketing.messages`;
  await teardownDb();
});

beforeEach(async () => {
  await resetDb();
  await db()`delete from pgboss.job where name like 'campaign.%'`;
  resetFake();
  await setup();
});

describe('quiet hours defer', () => {
  it('sends before 21:00, defers the rest to 09:00, then finishes', async () => {
    const ids = await seedContacts(TENANT_A, Array.from({ length: 10 }, (_, i) => sa(i)));
    const id = await campaignFor(ids, { throttlePerMinute: 6 });
    const job = await expand();

    const before = await processBatch(job, { now: AT_2058 });
    expect(before).toMatchObject({ state: 'sent', processed: 1, deferred: 0 });
    // Driven by hand: in production the next batch IS the job just queued.
    await db()`delete from pgboss.job where name = 'campaign.batch'`;

    const after = await processBatch(job, { now: AT_2100 });
    expect(after).toMatchObject({ state: 'waiting', processed: 0, deferred: 9, remaining: 9 });

    const rows = await recipients(job.runId);
    const waiting = rows.filter((r) => r.state === 'pending');
    expect(rows.filter((r) => r.state === 'queued')).toHaveLength(1);
    expect(waiting).toHaveLength(9);
    for (const r of waiting) {
      expect(r.not_before!.toISOString()).toBe(NEXT_0900.toISOString());
      expect(r.reason).toBe('deferred:sa-marketing-sms-hours');
      expect(r.message_id).toBeNull();
    }
    // Deferring writes no message and no message.blocked event.
    const messages = await db()<{ status: string }[]>`select status from messages`;
    expect(messages.map((m) => m.status)).toEqual(['queued']);
    const blockedEvents = await db()`select id from events where type = 'message.blocked'`;
    expect(blockedEvents).toHaveLength(0);

    // The next batch is queued for 09:00, not in ten seconds.
    const [next] = await jobs('campaign.batch');
    const waitSeconds = (next!.start_after.getTime() - Date.now()) / 1000;
    expect(waitSeconds).toBeGreaterThan(11.9 * 3600);
    expect(waitSeconds).toBeLessThanOrEqual(12 * 3600 + 5);

    const mid = await campaign(id);
    expect(mid.status).toBe('running');
    expect(mid.lastRun).toMatchObject({ status: 'sending', queued: 1, pending: 9, deferred: 9 });

    const pendingList = await call<{ items: { state: string; notBefore: string | null }[] }>(
      'GET', `/v1/campaigns/${id}/runs/${job.runId}/recipients?state=pending`,
    );
    expect(pendingList.body.items[0]!.notBefore).toBe(NEXT_0900.toISOString());

    await db()`delete from pgboss.job where name = 'campaign.batch'`;
    expect((await drain(job, NEXT_0900)).state).toBe('done');

    const done = await campaign(id);
    expect(done.status).toBe('done');
    expect(done.lastRun).toMatchObject({ status: 'done', queued: 10, blocked: 0, pending: 0, deferred: 0 });
  });

  it('blocks a recipient with no consent instead of deferring it', async () => {
    const [consented] = await seedContacts(TENANT_A, [sa(0)]);
    const [unconsented] = await seedContacts(TENANT_A, [sa(1)], false);
    await campaignFor([consented!, unconsented!], { throttlePerMinute: 600 });
    const job = await expand();

    await processBatch(job, { now: AT_2200 });

    const rows = new Map((await recipients(job.runId)).map((r) => [r.contact_id, r]));
    expect(rows.get(unconsented!)).toMatchObject({ state: 'blocked', reason: 'no_consent', not_before: null });
    expect(rows.get(consented!)).toMatchObject({ state: 'pending', reason: 'deferred:sa-marketing-sms-hours' });
  });

  it('does not defer a transactional campaign: the SA rule is marketing-only', async () => {
    const ids = await seedContacts(TENANT_A, [sa(0), sa(1)], false);
    const id = await campaignFor(ids, { purpose: 'transactional', throttlePerMinute: 600 });
    const job = await expand();

    expect((await processBatch(job, { now: AT_2300 })).state).toBe('done');
    expect((await recipients(job.runId)).map((r) => r.state)).toEqual(['queued', 'queued']);
    expect((await campaign(id)).status).toBe('done');
  });

  it('skips deferred recipients with reason cancelled on cancel', async () => {
    const ids = await seedContacts(TENANT_A, [sa(0), sa(1), sa(2)]);
    const id = await campaignFor(ids, { throttlePerMinute: 600 });
    const job = await expand();
    await processBatch(job, { now: AT_2200 });

    expect((await call('POST', `/v1/campaigns/${id}/cancel`)).status).toBe(200);

    const rows = await recipients(job.runId);
    expect(rows.map((r) => [r.state, r.reason])).toEqual([
      ['skipped', 'cancelled'],
      ['skipped', 'cancelled'],
      ['skipped', 'cancelled'],
    ]);
    expect((await campaign(id)).lastRun).toMatchObject({ status: 'cancelled', skipped: 3, pending: 0 });
  });

  it('blocks with no_sending_window when no window opens within seven days', async () => {
    // A tenant rule that denies every hour.
    const rule = await call('POST', '/v1/rules', {
      kind: 'sending_window',
      name: 'never',
      document: { '==': [1, 1] },
    });
    expect(rule.status).toBe(201);

    const ids = await seedContacts(TENANT_A, [sa(0), sa(1)]);
    const id = await campaignFor(ids, { throttlePerMinute: 600 });
    const job = await expand();

    expect((await processBatch(job, { now: AT_1000 })).state).toBe('done');
    const rows = await recipients(job.runId);
    expect(rows.map((r) => [r.state, r.reason, r.message_id])).toEqual([
      ['blocked', 'no_sending_window', null],
      ['blocked', 'no_sending_window', null],
    ]);
    expect((await campaign(id)).status).toBe('done');
  });

  it('searches for the next window once per region, not once per recipient', async () => {
    const ids = await seedContacts(TENANT_A, Array.from({ length: 500 }, (_, i) => `+9665010${String(i).padStart(5, '0')}`));
    await campaignFor(ids, { throttlePerMinute: 6 });
    const job = await expand();

    const searchesBefore = windowStats.searches;
    const outcome = await processBatch(job, { now: AT_2100 });

    expect(outcome).toMatchObject({ state: 'waiting', deferred: 500 });
    expect(windowStats.searches - searchesBefore).toBe(1);
  });
});

describe('the sweep', () => {
  async function recovered() {
    return db()<{ tenant_id: string; payload: { action: string } }[]>`
      select tenant_id::text, payload from events where type = 'campaign.run.recovered' order by id
    `;
  }

  it('re-enqueues a batch for a sending run that stopped moving, once', async () => {
    const ids = await seedContacts(TENANT_A, [`+14155550101`, `+14155550102`]);
    const id = await campaignFor(ids, { throttlePerMinute: 600 });
    const job = await expand(); // the batch job is gone, as if pg-boss gave up on it
    await db()`update campaign_runs set last_progress_at = now() - interval '6 minutes' where id = ${job.runId}`;

    expect(await sweepRuns()).toEqual([{ runId: job.runId, action: 'enqueue_batch' }]);
    expect(await sweepRuns()).toEqual([]);
    expect(await jobs('campaign.batch')).toHaveLength(1);
    expect((await recovered()).map((e) => e.payload.action)).toEqual(['enqueue_batch']);

    const [batch] = await jobs('campaign.batch');
    expect(batch!.data).toEqual(job);
    expect((await drain(job, new Date())).state).toBe('done');
    expect((await campaign(id)).status).toBe('done');
  });

  it('resumes an expanding run that stopped moving, with no duplicate recipients', async () => {
    const ids = await seedContacts(TENANT_A, Array.from({ length: 6 }, (_, i) => `+1415555${String(200 + i).padStart(4, '0')}`));
    const id = await campaignFor(ids, { throttlePerMinute: 600 });
    const job = await expand();
    // As if expansion died half way: some recipients written, still expanding.
    await db()`
      delete from campaign_recipients
      where run_id = ${job.runId}
        and contact_id in (select contact_id from campaign_recipients where run_id = ${job.runId} order by contact_id limit 3)
    `;
    await db()`
      update campaign_runs set status = 'expanding', audience_size = null,
             last_progress_at = now() - interval '11 minutes'
      where id = ${job.runId}
    `;

    expect(await sweepRuns()).toEqual([{ runId: job.runId, action: 'resume_expansion' }]);
    const [runJob] = await jobs('campaign.run');
    expect(runJob!.data).toMatchObject({ campaignId: id, runNo: 1 });

    await db()`delete from pgboss.job where id = ${runJob!.id}`;
    await runCampaign(runJob!.data);
    const rows = await recipients(job.runId);
    expect(rows).toHaveLength(6);
    expect(new Set(rows.map((r) => r.contact_id)).size).toBe(6);

    expect((await drain(job, new Date())).state).toBe('done');
    expect((await campaign(id)).lastRun).toMatchObject({ status: 'done', audienceSize: 6, queued: 6 });
  });

  it('finishes a sending run with nothing left pending', async () => {
    const ids = await seedContacts(TENANT_A, [`+14155550101`]);
    const id = await campaignFor(ids, { throttlePerMinute: 600 });
    const job = await expand();
    await drain(job, new Date());
    // As if the batch died right before finishing.
    await db()`update campaign_runs set status = 'sending', finished_at = null where id = ${job.runId}`;
    await db()`update campaigns set status = 'running' where id = ${id}`;

    expect(await sweepRuns()).toEqual([{ runId: job.runId, action: 'finish' }]);
    expect((await campaign(id)).status).toBe('done');
    expect((await campaign(id)).lastRun.status).toBe('done');
  });

  it("leaves a run waiting on a sending window alone", async () => {
    const ids = await seedContacts(TENANT_A, [sa(0)]);
    await campaignFor(ids, { throttlePerMinute: 600 });
    const job = await expand();
    await processBatch(job, { now: AT_2200 });
    await db()`update campaign_runs set last_progress_at = now() - interval '1 hour' where id = ${job.runId}`;

    // Its only pending recipient is not due until 09:00 (in 2027).
    expect(await sweepRuns()).toEqual([]);
  });

  it("touching tenant A's run writes nothing of tenant B's", async () => {
    const stuck = await seedContacts(TENANT_A, [`+14155550101`]);
    await campaignFor(stuck, { throttlePerMinute: 600 });
    const stuckJob = await expand();
    await db()`update campaign_runs set last_progress_at = now() - interval '6 minutes' where id = ${stuckJob.runId}`;

    await setup(tokenB);
    const healthy = await seedContacts(TENANT_B, [`+14155550102`]);
    await campaignFor(healthy, { throttlePerMinute: 600 }, tokenB);
    const healthyJob = await expand();

    const snapshot = () => db()`
      select r.last_progress_at, r.status, (select count(*) from events e where e.tenant_id = ${TENANT_B}) as events
      from campaign_runs r where r.id = ${healthyJob.runId}
    `;
    const before = await snapshot();

    expect(await sweepRuns()).toEqual([{ runId: stuckJob.runId, action: 'enqueue_batch' }]);
    expect(await snapshot()).toEqual(before);
    expect((await recovered()).map((e) => e.tenant_id)).toEqual([TENANT_A]);
    const [batch] = await jobs('campaign.batch');
    expect(batch!.data.tenantId).toBe(TENANT_A);
  });
});

describe('poison recipients', () => {
  it('skips a recipient whose send keeps throwing, and sends everyone else', async () => {
    const phones = [sa(0), sa(1), sa(2), sa(3)];
    const ids = await seedContacts(TENANT_A, phones);
    const id = await campaignFor(ids, { throttlePerMinute: 600 });
    const job = await expand();

    // Any message to this one address fails in the database: an error send()
    // does not expect, which is what a poison row looks like.
    await db().unsafe(`
      create or replace function marketing.poison_message() returns trigger language plpgsql as $$
      begin
        if new.address = '${sa(2)}' then raise exception 'poisoned row for test'; end if;
        return new;
      end $$;
      drop trigger if exists poison_messages on marketing.messages;
      create trigger poison_messages before insert on marketing.messages
        for each row execute function marketing.poison_message();
    `);

    const failures: string[] = [];
    let last;
    for (let i = 0; i < 10; i += 1) {
      try {
        last = await processBatch(job, { now: AT_1000 });
        if (last.state === 'done') break;
      } catch (err) {
        failures.push((err as Error).message);
      }
    }
    await db()`drop trigger poison_messages on marketing.messages`;

    // Thrown twice, so pg-boss would retry; the third time it is skipped.
    expect(failures).toHaveLength(2);
    expect(last!.state).toBe('done');

    const rows = await recipients(job.runId);
    const [contactRow] = await db()<{ id: string }[]>`select id from contacts where phone = ${sa(2)}`;
    const poisonedId = contactRow!.id;
    const poisoned = rows.find((r) => r.contact_id === poisonedId);
    expect(poisoned).toMatchObject({ state: 'skipped' });
    expect(poisoned!.reason).toMatch(/^error:.*poisoned row for test/);
    expect(rows.filter((r) => r.state === 'queued')).toHaveLength(3);

    const [attempts] = await db()<{ attempts: number }[]>`
      select attempts from campaign_recipients where run_id = ${job.runId} and contact_id = ${poisonedId}
    `;
    expect(attempts!.attempts).toBe(3);
    expect((await campaign(id)).lastRun).toMatchObject({ status: 'done', queued: 3, skipped: 1 });
  });
});
