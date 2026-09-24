import { db } from '../../../db/client.js';
import type { Window } from './shared.js';

/**
 * The campaigns section of the operator read side. Cross-tenant, and like the
 * other feeds every row says whose it is.
 */

export async function campaignSection(window: Window) {
  const [row] = await db()<Record<string, string>[]>`
    select
      (select count(*) from campaigns where status = 'scheduled')::text as scheduled,
      (select count(*) from campaigns where status = 'running')::text as running,
      (select count(*) from campaign_recipients r
       join campaign_runs cr on cr.id = r.run_id
       where r.state = 'pending' and cr.status in ('expanding', 'sending'))::text as pending,
      (select count(*) from messages
       where campaign_run_id is not null and status <> 'blocked'
         and created_at >= ${window.since} and created_at < ${window.until})::text as sent,
      (select count(*) from messages
       where campaign_run_id is not null and status = 'blocked'
         and created_at >= ${window.since} and created_at < ${window.until})::text as blocked
  `;
  return {
    scheduled: Number(row?.['scheduled'] ?? 0),
    running: Number(row?.['running'] ?? 0),
    recipientsPending: Number(row?.['pending'] ?? 0),
    sentInWindow: Number(row?.['sent'] ?? 0),
    blockedInWindow: Number(row?.['blocked'] ?? 0),
  };
}

/** A run with its counts. A function, so importing this file opens no pool. */
const runColumns = () => db()`
  r.id::text as id, r.run_no as "runNo", r.status, r.started_at as "startedAt",
  r.finished_at as "finishedAt", r.audience_size as "audienceSize",
  r.queued, r.blocked, r.skipped, r.error,
  (select count(*)::int from campaign_recipients p where p.run_id = r.id and p.state = 'pending') as pending,
  (select count(*)::int from campaign_recipients p
   where p.run_id = r.id and p.state = 'pending' and p.not_before > now()) as deferred
`;

export async function campaigns(input: {
  tenantId?: string | undefined;
  status?: string | undefined;
  limit: number;
  cursor?: string | undefined;
}) {
  const sql = db();
  return sql<Record<string, unknown>[]>`
    select c.id::text as id, c.tenant_id::text as "tenantId", t.name as "tenantName",
           c.name, c.status, c.purpose, c.channel, c.template,
           c.audience_id::text as "audienceId", a.name as "audienceName",
           c.throttle_per_minute as "throttlePerMinute", c.recurrence, c.timezone,
           c.scheduled_at as "scheduledAt", c.next_run_at as "nextRunAt",
           c.created_at as "createdAt", c.updated_at as "updatedAt",
           (select row_to_json(last) from (
              select ${runColumns()} from campaign_runs r
              where r.campaign_id = c.id order by r.run_no desc limit 1
            ) last) as "lastRun"
    from campaigns c
    join tenants t on t.id = c.tenant_id
    join audiences a on a.id = c.audience_id
    where true
      ${input.tenantId ? sql`and c.tenant_id = ${input.tenantId}` : sql``}
      ${input.status ? sql`and c.status = ${input.status}` : sql``}
      ${input.cursor ? sql`and (c.created_at, c.id) < (select created_at, id from campaigns where id = ${input.cursor})` : sql``}
    order by c.created_at desc, c.id desc
    limit ${input.limit}
  `;
}

export async function oneCampaign(id: string) {
  const [campaign] = await db()<Record<string, unknown>[]>`
    select c.id::text as id, c.tenant_id::text as "tenantId", t.name as "tenantName",
           c.name, c.status, c.purpose, c.channel, c.template, c.variables,
           c.audience_id::text as "audienceId", a.name as "audienceName", a.kind as "audienceKind",
           c.throttle_per_minute as "throttlePerMinute", c.recurrence, c.timezone,
           c.scheduled_at as "scheduledAt", c.next_run_at as "nextRunAt",
           c.created_at as "createdAt", c.updated_at as "updatedAt"
    from campaigns c
    join tenants t on t.id = c.tenant_id
    join audiences a on a.id = c.audience_id
    where c.id = ${id}
  `;
  if (!campaign) return undefined;

  const runs = await db()<Record<string, unknown>[]>`
    select ${runColumns()} from campaign_runs r
    where r.campaign_id = ${id}
    order by r.run_no desc
  `;
  return { campaign, runs };
}

export async function recipients(input: {
  campaignId: string;
  runId: string;
  state?: string | undefined;
  limit: number;
  cursor?: string | undefined;
}) {
  const sql = db();
  return sql<Record<string, unknown>[]>`
    select r.contact_id::text as id, c.name, c.phone, c.email, c.telegram,
           r.state, r.reason, r.not_before as "notBefore", r.message_id::text as "messageId",
           m.channel, m.status as "messageStatus", m.blocked_reason as "messageBlockedReason",
           m.error as "messageError", m.updated_at as "messageUpdatedAt"
    from campaign_recipients r
    join campaign_runs cr on cr.id = r.run_id
    join contacts c on c.id = r.contact_id
    left join messages m on m.id = r.message_id
    where r.run_id = ${input.runId} and cr.campaign_id = ${input.campaignId}
      ${input.state ? sql`and r.state = ${input.state}` : sql``}
      ${input.cursor ? sql`and r.contact_id > ${input.cursor}` : sql``}
    order by r.contact_id
    limit ${input.limit}
  `;
}
