import { withTenant, type Tx } from '../../db/client.js';
import { InvalidAddressError } from '../../spine/contacts/normalize.js';
import { emit } from '../../spine/events/index.js';
import { resolve as resolveCompany } from '../../spine/registry/index.js';
import { MessagingError } from '../messaging/errors.js';
import { send } from '../messaging/index.js';
import { MAX_AUDIENCE, getAudience, resolveAudience } from './audiences.js';
import {
  BATCH_INTERVAL_SECONDS,
  MAX_RUNNING_PER_TENANT,
  enqueueBatch,
  enqueueRun,
  getCampaign,
  nextRunAt,
  runningCount,
  type CampaignRow,
  type RunRow,
} from './campaigns.js';
import { contactInput, type ContactRow } from './contacts.js';

/** Recipients are written in chunks this size, each in its own transaction. */
const EXPANSION_CHUNK = 1000;

/** How long a run waits when its tenant already has the most campaigns running. */
const BACKPRESSURE_SECONDS = 60;

export type RunJob = { tenantId: string; campaignId: string; runNo: number };
export type BatchJob = { tenantId: string; runId: string };

/**
 * `campaign.run`: start run `runNo`, snapshot the audience into recipients,
 * and hand over to the batch worker. Sends nothing: expansion snapshots,
 * batches send.
 *
 * Safe to deliver twice. The run row is unique on (campaign, run_no), so the
 * second delivery either finds the run past expansion and stops, or finds it
 * still expanding and finishes the same snapshot, which inserts nothing twice.
 */
export async function runCampaign(job: RunJob): Promise<void> {
  const started = await withTenant(job.tenantId, (tx) => startRun(tx, job));
  if (!started) return;
  const { campaign, run } = started;

  try {
    const ids = await withTenant(job.tenantId, async (tx) => {
      const audience = await getAudience(tx, campaign.audience_id);
      if (!audience) throw new Error(`audience ${campaign.audience_id} is gone`);
      return resolveAudience(tx, audience, { limit: MAX_AUDIENCE });
    });

    for (let start = 0; start < ids.length; start += EXPANSION_CHUNK) {
      const chunk = ids.slice(start, start + EXPANSION_CHUNK);
      await withTenant(job.tenantId, (tx) => tx`
        insert into campaign_recipients (run_id, tenant_id, contact_id, state)
        select ${run.id}, ${job.tenantId}, unnest(${chunk}::uuid[]), 'pending'
        on conflict do nothing
      `);
    }

    await withTenant(job.tenantId, async (tx) => {
      // Only if still expanding: a cancel while this ran has the last word.
      const [sending] = await tx<RunRow[]>`
        update campaign_runs set
          status = 'sending',
          audience_size = (select count(*)::int from campaign_recipients where run_id = ${run.id})
        where id = ${run.id} and status = 'expanding'
        returning *
      `;
      if (sending) await enqueueBatch(tx, sending);
    });
  } catch (err) {
    await failRun(job.tenantId, campaign, run, (err as Error).message);
  }
}

/**
 * Open the run, or pick up one a previous delivery left expanding. Null when
 * there is nothing to do: the campaign was paused, cancelled or finished, the
 * run is already past expansion, or the tenant has no room and it was put back.
 */
async function startRun(
  tx: Tx,
  job: RunJob,
): Promise<{ campaign: CampaignRow; run: RunRow } | null> {
  const campaign = await getCampaign(tx, job.campaignId, true);
  if (!campaign || (campaign.status !== 'scheduled' && campaign.status !== 'running')) return null;

  const [existing] = await tx<RunRow[]>`
    select * from campaign_runs where campaign_id = ${campaign.id} and run_no = ${job.runNo}
  `;
  if (existing) return existing.status === 'expanding' ? { campaign, run: existing } : null;

  if (
    campaign.status === 'scheduled' &&
    (await runningCount(tx, campaign.tenant_id, campaign.id)) >= MAX_RUNNING_PER_TENANT
  ) {
    await enqueueRun(tx, campaign, job.runNo, new Date(Date.now() + BACKPRESSURE_SECONDS * 1000));
    return null;
  }

  const [run] = await tx<RunRow[]>`
    insert into campaign_runs (tenant_id, campaign_id, run_no, status)
    values (${campaign.tenant_id}, ${campaign.id}, ${job.runNo}, 'expanding')
    on conflict (campaign_id, run_no) do nothing
    returning *
  `;
  if (!run) return null;

  // The next occurrence goes on the queue now, before this run sends
  // anything, so a long run cannot push the next one back.
  const next = nextRunAt(campaign, { after: new Date(), runsSoFar: job.runNo });
  if (next && campaign.recurrence) await enqueueRun(tx, campaign, job.runNo + 1, next);

  const [updated] = await tx<CampaignRow[]>`
    update campaigns set
      status = 'running',
      next_run_at = ${campaign.recurrence ? next : null},
      updated_at = now()
    where id = ${campaign.id}
    returning *
  `;

  await emit(tx, {
    tenantId: campaign.tenant_id,
    type: 'campaign.run.started',
    subjectType: 'campaign',
    subjectId: campaign.id,
    payload: {
      runId: run.id,
      runNo: run.run_no,
      nextRunAt: campaign.recurrence && next ? next.toISOString() : null,
    },
  });

  return { campaign: updated!, run };
}

async function failRun(tenantId: string, campaign: CampaignRow, run: RunRow, error: string): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    await tx`
      update campaign_runs set status = 'failed', error = ${error}, finished_at = now()
      where id = ${run.id} and status in ('expanding', 'sending')
    `;
    const [failed] = await tx`
      update campaigns set status = 'failed', next_run_at = null, updated_at = now()
      where id = ${campaign.id} and status not in ('cancelled', 'done')
      returning id
    `;
    if (!failed) return;
    await emit(tx, {
      tenantId,
      type: 'campaign.failed',
      subjectType: 'campaign',
      subjectId: campaign.id,
      payload: { runId: run.id, runNo: run.run_no, error },
    });
  });
}

export type BatchOutcome = {
  /** What happened to the run as a result of this batch. */
  state: 'sent' | 'paused' | 'done' | 'stopped';
  processed: number;
  remaining: number;
};

/**
 * `campaign.batch`: send to the next slice of pending recipients, then either
 * queue the next slice ten seconds out or finish the run.
 *
 * A slice is a tenth of the campaign's per-minute allowance, so batches ten
 * seconds apart hold the rate. Each recipient is its own transaction, locked
 * while it sends, so two batches for one run can never send to anyone twice.
 */
export async function processBatch(job: BatchJob): Promise<BatchOutcome> {
  const context = await withTenant(job.tenantId, async (tx) => {
    const [run] = await tx<RunRow[]>`select * from campaign_runs where id = ${job.runId}`;
    const campaign = run ? await getCampaign(tx, run.campaign_id) : undefined;
    return run && campaign ? { run, campaign } : null;
  });
  if (!context || context.run.status !== 'sending') return { state: 'stopped', processed: 0, remaining: 0 };
  const { run, campaign } = context;
  if (campaign.status !== 'running') {
    return { state: campaign.status === 'paused' ? 'paused' : 'stopped', processed: 0, remaining: 0 };
  }

  const size = Math.ceil(campaign.throttle_per_minute / 6);
  const pending = await withTenant(job.tenantId, (tx) => tx<{ contact_id: string }[]>`
    select contact_id from campaign_recipients
    where run_id = ${run.id} and state = 'pending'
    order by contact_id
    limit ${size}
  `);

  let processed = 0;
  for (const { contact_id } of pending) {
    if (await sendOne(job.tenantId, campaign, run, contact_id)) processed += 1;
  }

  return withTenant(job.tenantId, async (tx) => {
    const [left] = await tx<{ n: number }[]>`
      select count(*)::int as n from campaign_recipients
      where run_id = ${run.id} and state = 'pending'
    `;
    const remaining = left?.n ?? 0;

    if (remaining > 0) {
      // Checked again: a pause that landed during the slice stops the chain here.
      const current = await getCampaign(tx, campaign.id);
      if (current?.status !== 'running') {
        return { state: current?.status === 'paused' ? 'paused' : 'stopped', processed, remaining };
      }
      await enqueueBatch(tx, run, BATCH_INTERVAL_SECONDS);
      return { state: 'sent', processed, remaining };
    }

    await finishRun(tx, campaign, run.id);
    return { state: 'done', processed, remaining };
  });
}

/**
 * One recipient through messaging.send(), exactly as a single API send goes:
 * consent, rules, selection, templates and fallback all apply. False when
 * someone else already took this recipient.
 */
async function sendOne(
  tenantId: string,
  campaign: CampaignRow,
  run: RunRow,
  contactId: string,
): Promise<boolean> {
  return withTenant(tenantId, async (tx) => {
    const [recipient] = await tx<{ contact_id: string }[]>`
      select contact_id from campaign_recipients
      where run_id = ${run.id} and contact_id = ${contactId} and state = 'pending'
      for update skip locked
    `;
    if (!recipient) return false;

    const [contact] = await tx<ContactRow[]>`select * from contacts where id = ${contactId}`;
    const company = contact?.company_id ? await resolveCompany(tx, contact.company_id) : undefined;

    let state: 'queued' | 'blocked' | 'skipped';
    let reason: string | null = null;
    let messageId: string | null = null;

    try {
      if (!contact) throw new InvalidAddressError('contact is gone');
      const message = await tx.savepoint((sp) =>
        send(sp, {
          tenantId,
          contact: contactInput(contact),
          ...(campaign.channel ? { channel: campaign.channel } : {}),
          purpose: campaign.purpose,
          template: campaign.template,
          variables: {
            ...campaign.variables,
            contact: {
              id: contact.id,
              name: contact.name,
              locale: contact.locale,
              phone: contact.phone,
              email: contact.email,
              telegram: contact.telegram,
              attributes: contact.attributes,
            },
            company: company ? { id: company.id, name: company.name, country: company.country } : null,
          },
          campaignRunId: run.id,
        }),
      );
      messageId = message.id;
      state = message.status === 'blocked' ? 'blocked' : 'queued';
      reason = message.reason;
    } catch (err) {
      // Not a refusal but an intent that cannot be sent at all: no template
      // for the channel picked, no unsubscribe text, a variable missing.
      if (err instanceof MessagingError) reason = err.code;
      else if (err instanceof InvalidAddressError) reason = 'invalid_address';
      else throw err;
      state = 'skipped';
    }

    await tx`
      update campaign_recipients set state = ${state}, reason = ${reason}, message_id = ${messageId}
      where run_id = ${run.id} and contact_id = ${contactId}
    `;
    await tx`
      update campaign_runs set
        queued  = queued  + ${state === 'queued' ? 1 : 0},
        blocked = blocked + ${state === 'blocked' ? 1 : 0},
        skipped = skipped + ${state === 'skipped' ? 1 : 0}
      where id = ${run.id}
    `;
    return true;
  });
}

/**
 * Mark the run done, once, and move the campaign on: back to scheduled when a
 * recurrence has another run coming, done when it has not.
 */
async function finishRun(tx: Tx, campaign: CampaignRow, runId: string): Promise<void> {
  const [done] = await tx<RunRow[]>`
    update campaign_runs set status = 'done', finished_at = now()
    where id = ${runId} and status = 'sending'
      and not exists (
        select 1 from campaign_recipients where run_id = ${runId} and state = 'pending'
      )
    returning *
  `;
  if (!done) return;

  await emit(tx, {
    tenantId: campaign.tenant_id,
    type: 'campaign.run.finished',
    subjectType: 'campaign',
    subjectId: campaign.id,
    payload: {
      runId: done.id,
      runNo: done.run_no,
      audienceSize: done.audience_size,
      queued: done.queued,
      blocked: done.blocked,
      skipped: done.skipped,
    },
  });

  const [busy] = await tx`
    select 1 from campaign_runs
    where campaign_id = ${campaign.id} and status in ('expanding', 'sending')
  `;
  if (busy) return;

  const current = await getCampaign(tx, campaign.id, true);
  if (current?.status !== 'running') return;

  const status = current.next_run_at ? 'scheduled' : 'done';
  await tx`update campaigns set status = ${status}, updated_at = now() where id = ${campaign.id}`;
  if (status === 'done') {
    await emit(tx, {
      tenantId: campaign.tenant_id,
      type: 'campaign.done',
      subjectType: 'campaign',
      subjectId: campaign.id,
      payload: { runs: done.run_no },
    });
  }
}
