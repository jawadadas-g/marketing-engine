import type { Tx } from '../../db/client.js';
import { enqueue, queueStarted } from '../../jobs/queue.js';

export type EventRow = {
  id: string;
  tenant_id: string;
  type: string;
  subject_type: string | null;
  subject_id: string | null;
  payload: unknown;
  occurred_at: Date;
};

export type EmitInput = {
  tenantId: string;
  type: string;
  subjectType?: string | undefined;
  subjectId?: string | undefined;
  payload?: unknown;
};

/**
 * Append one event. Takes the caller's transaction so the event lands or rolls
 * back with whatever the caller was doing. Every module writes here; nothing
 * else records what happened.
 */
export async function emit(tx: Tx, input: EmitInput): Promise<EventRow> {
  const [row] = await tx<EventRow[]>`
    insert into events (tenant_id, type, subject_type, subject_id, payload)
    values (
      ${input.tenantId},
      ${input.type},
      ${input.subjectType ?? null},
      ${input.subjectId ?? null},
      ${tx.json((input.payload ?? {}) as never)}
    )
    returning *
  `;
  if (!row) throw new Error('events.emit inserted no row');

  // Fan the event out to whoever is listening, on this same transaction: an
  // event that commits always fans out, and one that rolls back never does.
  // Nothing about the outcome of a delivery comes back here.
  if (queueStarted()) {
    await enqueue(tx, FANOUT_JOB, { eventId: String(row.id) });
  }

  return row;
}

/**
 * Named here rather than imported from the webhooks module, which imports this
 * one. The queue is a string either way.
 */
const FANOUT_JOB = 'webhook.fanout';

export type ListInput = {
  tenantId: string;
  type?: string | undefined;
  since?: Date | undefined;
  limit: number;
};

/** Read a tenant's events, newest first. RLS scopes the rows; this narrows them. */
export async function list(tx: Tx, input: ListInput): Promise<EventRow[]> {
  return tx<EventRow[]>`
    select * from events
    where tenant_id = ${input.tenantId}
      ${input.type ? tx`and type = ${input.type}` : tx``}
      ${input.since ? tx`and occurred_at >= ${input.since}` : tx``}
    order by occurred_at desc, id desc
    limit ${input.limit}
  `;
}
