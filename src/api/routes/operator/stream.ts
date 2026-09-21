import { db } from '../../../db/client.js';

/**
 * The live feed.
 *
 * One LISTEN connection for the whole process, fanned out in memory. The
 * alternative — a connection per watcher — would put an operator dashboard in
 * a position to exhaust the pool by opening tabs.
 *
 * NOTIFY fires only when the inserting transaction commits, so a rolled-back
 * event never reaches a watcher. That is the property that makes this correct
 * rather than merely fast.
 */
export type StreamEvent = {
  id: string;
  type: string;
  tenantId: string;
  tenantName?: string;
  subjectType: string | null;
  subjectId: string | null;
  occurredAt: string;
};

export const MAX_CLIENTS = 20;
export const HEARTBEAT_MS = 15_000;
/** A reconnect replays what it missed, but not an unbounded backlog. */
export const MAX_REPLAY = 1000;

type Watcher = (event: StreamEvent) => void;

const watchers = new Set<Watcher>();
let listening: { unlisten: () => Promise<void> } | undefined;

export function watcherCount(): number {
  return watchers.size;
}

export async function watch(fn: Watcher): Promise<() => Promise<void>> {
  await startListening();
  watchers.add(fn);

  return async () => {
    watchers.delete(fn);
    // The last watcher out closes the connection; a dashboard nobody has open
    // should not hold one.
    if (watchers.size === 0) await stopListening();
  };
}

async function startListening(): Promise<void> {
  if (listening) return;

  const handle = await db().listen('marketing_events', (payload) => {
    let event: StreamEvent;
    try {
      event = JSON.parse(payload) as StreamEvent;
    } catch {
      console.warn('stream: notify payload was not JSON', payload);
      return;
    }
    for (const watcher of watchers) watcher(event);
  });

  listening = handle;
}

export async function stopListening(): Promise<void> {
  if (!listening) return;
  const handle = listening;
  listening = undefined;
  await handle.unlisten().catch(() => {});
}

/** Everything after `lastId`, for a client that reconnected. */
export async function replaySince(
  lastId: string,
  filters: { tenantId?: string | undefined; type?: string | undefined },
): Promise<StreamEvent[]> {
  const sql = db();
  const prefix = filters.type?.endsWith('*') ? filters.type.slice(0, -1) : null;

  const rows = await sql<Record<string, unknown>[]>`
    select e.id::text as id, e.type, e.tenant_id::text as "tenantId", t.name as "tenantName",
           e.subject_type as "subjectType", e.subject_id as "subjectId",
           e.occurred_at as "occurredAt"
    from events e join tenants t on t.id = e.tenant_id
    where e.id > ${lastId}
      ${filters.tenantId ? sql`and e.tenant_id = ${filters.tenantId}` : sql``}
      ${prefix ? sql`and e.type like ${`${prefix}%`}` : sql``}
      ${filters.type && !prefix ? sql`and e.type = ${filters.type}` : sql``}
    order by e.id
    limit ${MAX_REPLAY}
  `;

  return rows.map((r) => ({
    id: r['id'] as string,
    type: r['type'] as string,
    tenantId: r['tenantId'] as string,
    tenantName: r['tenantName'] as string,
    subjectType: r['subjectType'] as string | null,
    subjectId: r['subjectId'] as string | null,
    occurredAt: (r['occurredAt'] as Date).toISOString(),
  }));
}

export function matches(
  event: StreamEvent,
  filters: { tenantId?: string | undefined; type?: string | undefined },
): boolean {
  if (filters.tenantId && event.tenantId !== filters.tenantId) return false;
  if (filters.type) {
    const ok = filters.type.endsWith('*')
      ? event.type.startsWith(filters.type.slice(0, -1))
      : event.type === filters.type;
    if (!ok) return false;
  }
  return true;
}

/** Notify carries no tenant name; one lookup fills it in for the whole stream. */
const names = new Map<string, string>();

export async function tenantName(tenantId: string): Promise<string> {
  const cached = names.get(tenantId);
  if (cached) return cached;

  const [row] = await db()<{ name: string }[]>`select name from tenants where id = ${tenantId}`;
  const name = row?.name ?? 'unknown';
  names.set(tenantId, name);
  return name;
}

export function forgetTenantNames(): void {
  names.clear();
}
