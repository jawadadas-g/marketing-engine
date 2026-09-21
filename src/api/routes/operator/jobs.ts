import { db } from '../../../db/client.js';
import { queue } from '../../../jobs/queue.js';

/**
 * pg-boss's tables, read through this API rather than exposed. Column names
 * come from the installed schema: `retry_count`, `created_on`, `started_on`,
 * `completed_on`, `output`.
 */
export type JobRow = Record<string, unknown>;

export async function jobs(input: {
  name?: string | undefined;
  state?: string | undefined;
  limit: number;
  cursor?: string | undefined;
}): Promise<JobRow[]> {
  const sql = db();

  const rows = await sql<JobRow[]>`
    select id::text as id, name, state::text as state, retry_count as "retryCount",
           retry_limit as "retryLimit", data, output,
           created_on as "createdOn", started_on as "startedOn",
           completed_on as "completedOn"
    from pgboss.job
    where true
      ${input.name ? sql`and name = ${input.name}` : sql``}
      ${input.state ? sql`and state = ${input.state}::pgboss.job_state` : sql``}
      ${input.cursor ? sql`and created_on < (select created_on from pgboss.job where id = ${input.cursor})` : sql``}
    order by created_on desc, id desc
    limit ${input.limit}
  `;

  return withTenant(rows);
}

export async function oneJob(id: string): Promise<JobRow | undefined> {
  const [row] = await db()<JobRow[]>`
    select id::text as id, name, state::text as state, retry_count as "retryCount",
           retry_limit as "retryLimit", data, output,
           created_on as "createdOn", started_on as "startedOn",
           completed_on as "completedOn"
    from pgboss.job where id = ${id}
  `;
  if (!row) return undefined;
  return (await withTenant([row]))[0];
}

/**
 * A job's data points at a message or a redemption. Resolving that here saves
 * the operator a second lookup to answer "whose job is this?".
 */
async function withTenant(rows: JobRow[]): Promise<JobRow[]> {
  const messageIds = ids(rows, 'messageId');
  const deliveryIds = ids(rows, 'deliveryId');

  const [messages, deliveries] = await Promise.all([
    messageIds.length
      ? db()<{ id: string; tenant_id: string; name: string }[]>`
          select m.id::text as id, m.tenant_id::text as tenant_id, t.name
          from messages m join tenants t on t.id = m.tenant_id
          where m.id = any(${messageIds}::uuid[])
        `
      : Promise.resolve([]),
    deliveryIds.length
      ? db()<{ id: string; tenant_id: string | null; name: string | null }[]>`
          select d.id::text as id, e.tenant_id::text as tenant_id, t.name
          from webhook_deliveries d
          join webhook_endpoints e on e.id = d.endpoint_id
          left join tenants t on t.id = e.tenant_id
          where d.id = any(${deliveryIds}::bigint[])
        `
      : Promise.resolve([]),
  ]);

  return rows.map((row) => {
    const data = (row['data'] ?? {}) as Record<string, unknown>;
    const owner =
      messages.find((m) => m.id === data['messageId']) ??
      deliveries.find((d) => d.id === String(data['deliveryId']));
    return owner
      ? { ...row, tenantId: owner.tenant_id, tenantName: owner.name }
      : { ...row, tenantId: null, tenantName: null };
  });
}

function ids(rows: JobRow[], key: string): string[] {
  return [
    ...new Set(
      rows
        .map((r) => (r['data'] as Record<string, unknown> | null)?.[key])
        .filter((v): v is string | number => v !== undefined && v !== null)
        .map(String),
    ),
  ];
}

export type RetryResult =
  | { ok: true; id: string }
  | { ok: false; reason: 'not_found' | 'not_failed'; state?: string };

/** Only a failed job. Anything else is either still going or already done. */
export async function retryJob(id: string): Promise<RetryResult> {
  const [row] = await db()<{ id: string; name: string; state: string }[]>`
    select id::text as id, name, state::text as state from pgboss.job where id = ${id}
  `;
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.state !== 'failed') return { ok: false, reason: 'not_failed', state: row.state };

  // pg-boss's own retry, so the job keeps its identity and history rather than
  // becoming a lookalike with a new id.
  await queue().retry(row.name, row.id);
  return { ok: true, id: row.id };
}

/** Each schedule with when its job last finished, and how. */
export async function schedules(): Promise<Record<string, unknown>[]> {
  return db()<Record<string, unknown>[]>`
    select s.name, s.cron, s.timezone, s.data,
           s.created_on as "createdOn", s.updated_on as "updatedOn",
           last.completed_on as "lastCompletedOn",
           last.state as "lastState",
           last.output as "lastOutput"
    from pgboss.schedule s
    left join lateral (
      select completed_on, state::text as state, output from (
        select completed_on, state, output from pgboss.job
        where name = s.name and completed_on is not null
        union all
        select completed_on, state, output from pgboss.archive
        where name = s.name and completed_on is not null
      ) runs
      order by completed_on desc
      limit 1
    ) last on true
    order by s.name
  `;
}
