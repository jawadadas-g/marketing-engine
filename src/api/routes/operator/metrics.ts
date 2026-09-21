import { db } from '../../../db/client.js';
import type { Window } from './shared.js';

export type Series = 'messages' | 'events' | 'redemptions' | 'searches';
export type Bucket = 'hour' | 'day';

/**
 * Enough for a chart and nothing more: one date_trunc query, a key per group,
 * points as [timestamp, count]. Deliberately not a metrics system.
 */
export async function metrics(input: {
  series: Series;
  bucket: Bucket;
  window: Window;
  tenantId?: string | undefined;
  groupBy?: 'status' | 'channel' | 'type' | undefined;
}) {
  const sql = db();
  const source = SOURCES[input.series];
  const group = groupColumn(input.series, input.groupBy);

  const rows = await sql<{ bucket: Date; key: string; n: string }[]>`
    select date_trunc(${input.bucket}, ${sql(source.time)}) as bucket,
           ${group ? sql`coalesce(${sql(group)}::text, 'unknown')` : sql`'all'`} as key,
           count(*)::text as n
    from ${sql(source.table)}
    where ${sql(source.time)} >= ${input.window.since}
      and ${sql(source.time)} < ${input.window.until}
      ${input.tenantId ? sql`and tenant_id = ${input.tenantId}` : sql``}
    group by 1, 2
    order by 1
  `;

  const keys = [...new Set(rows.map((r) => r.key))].sort();
  return {
    bucket: input.bucket,
    series: keys.map((key) => ({
      key,
      points: rows
        .filter((r) => r.key === key)
        .map((r) => [r.bucket.toISOString(), Number(r.n)] as [string, number]),
    })),
  };
}

const SOURCES: Record<Series, { table: string; time: string }> = {
  messages: { table: 'messages', time: 'created_at' },
  events: { table: 'events', time: 'occurred_at' },
  redemptions: { table: 'redemptions', time: 'reserved_at' },
  searches: { table: 'finder_runs', time: 'created_at' },
};

/** Only a grouping the series actually has, so a bad pair is ignored rather than erroring. */
function groupColumn(series: Series, groupBy: string | undefined): string | null {
  if (!groupBy) return null;
  const allowed: Record<Series, string[]> = {
    messages: ['status', 'channel'],
    events: ['type'],
    redemptions: ['status'],
    searches: [],
  };
  return allowed[series].includes(groupBy) ? groupBy : null;
}
