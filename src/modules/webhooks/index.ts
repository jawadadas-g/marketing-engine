import { randomBytes } from 'node:crypto';
import { db, type Tx } from '../../db/client.js';
import { env } from '../../env.js';
import { enqueue } from '../../jobs/queue.js';
import { span } from '../../otel.js';
import { signPayload } from './signature.js';

export * from './signature.js';

export const FANOUT_JOB = 'webhook.fanout';
export const DELIVER_JOB = 'webhook.deliver';

/**
 * When each attempt happens, in seconds. Five retries, chosen rather than
 * guessed: a minute covers a deploy, twelve hours covers an outage someone has
 * to wake up for.
 */
export const RETRY_SCHEDULE_SECONDS = [60, 5 * 60, 30 * 60, 2 * 60 * 60, 12 * 60 * 60];

const DELIVERY_TIMEOUT_MS = 10_000;

export type EndpointRow = {
  id: string;
  tenant_id: string | null;
  url: string;
  secret: string;
  event_types: string[];
  active: boolean;
  created_at: Date;
};

export type DeliveryRow = {
  id: string;
  endpoint_id: string;
  event_id: string;
  attempt: number;
  status: 'pending' | 'delivered' | 'failed';
  last_status_code: number | null;
  last_error: string | null;
  next_attempt_at: Date | null;
  delivered_at: Date | null;
  created_at: Date;
};

export class WebhookError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 404,
    message?: string,
  ) {
    super(message ?? code);
  }
}

/** An endpoint without its secret. The secret is shown once, at creation. */
export function redactEndpoint(row: EndpointRow) {
  return {
    id: row.id,
    url: row.url,
    eventTypes: row.event_types,
    active: row.active,
    createdAt: row.created_at.toISOString(),
  };
}

function assertUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new WebhookError('invalid_url', 400, 'the endpoint url must be absolute');
  }
  // http is allowed only where the engine itself is running over http, which
  // in practice means local development.
  const allowHttp = env().PUBLIC_BASE_URL.startsWith('http://');
  if (parsed.protocol !== 'https:' && !(allowHttp && parsed.protocol === 'http:')) {
    throw new WebhookError('invalid_url', 400, 'the endpoint url must be https');
  }
}

export async function createEndpoint(
  tx: Tx,
  input: { tenantId: string | null; url: string; eventTypes?: string[] | undefined },
): Promise<{ endpoint: EndpointRow; secret: string }> {
  assertUrl(input.url);
  const secret = randomBytes(32).toString('base64url');

  const [row] = await tx<EndpointRow[]>`
    insert into webhook_endpoints (tenant_id, url, secret, event_types)
    values (${input.tenantId}, ${input.url}, ${secret}, ${input.eventTypes ?? []})
    returning *
  `;
  if (!row) throw new Error('webhooks: createEndpoint wrote no row');
  return { endpoint: row, secret };
}

/**
 * Turn one committed event into one pending delivery per interested endpoint.
 * Runs as the owning role: an event belongs to a tenant, but the platform
 * endpoint hears every tenant's, so this cannot be scoped to one.
 */
export async function fanOut(eventId: string): Promise<number> {
  const [event] = await db()<{ id: string; tenant_id: string; type: string }[]>`
    select id, tenant_id, type from events where id = ${eventId}
  `;
  // The fan-out job commits with its event, so a job without one is a bug.
  if (!event) throw new Error(`webhooks: event ${eventId} has a job but no row`);

  const endpoints = await db()<EndpointRow[]>`
    select * from webhook_endpoints
    where active
      and (tenant_id = ${event.tenant_id} or tenant_id is null)
      and (cardinality(event_types) = 0 or ${event.type} = any(event_types))
  `;

  for (const endpoint of endpoints) {
    await db().begin(async (tx) => {
      const [delivery] = await tx<DeliveryRow[]>`
        insert into webhook_deliveries (endpoint_id, event_id, status)
        values (${endpoint.id}, ${event.id}, 'pending')
        on conflict (endpoint_id, event_id) do nothing
        returning *
      `;
      // Already fanned out; the job ran twice and the second time is a no-op.
      if (!delivery) return;
      await enqueue(tx, DELIVER_JOB, { deliveryId: delivery.id });
    });
  }

  return endpoints.length;
}

/**
 * Post one delivery. Never throws for a rejection by the receiver: a failed
 * delivery is a row to look at and retry, not a crashed worker.
 */
export async function deliver(deliveryId: string): Promise<'delivered' | 'pending' | 'failed'> {
  const [row] = await db()<(DeliveryRow & { url: string; secret: string })[]>`
    select d.*, e.url, e.secret
    from webhook_deliveries d
    join webhook_endpoints e on e.id = d.endpoint_id
    where d.id = ${deliveryId}
  `;
  if (!row) throw new Error(`webhooks: no delivery ${deliveryId}`);
  if (row.status === 'delivered') return 'delivered';

  const [event] = await db()<
    { id: string; tenant_id: string; type: string; payload: unknown; occurred_at: Date }[]
  >`select id, tenant_id, type, payload, occurred_at from events where id = ${row.event_id}`;
  if (!event) throw new Error(`webhooks: delivery ${deliveryId} has no event`);

  const body = JSON.stringify({
    id: String(event.id),
    type: event.type,
    tenantId: event.tenant_id,
    occurredAt: event.occurred_at.toISOString(),
    data: event.payload,
  });
  const timestamp = Math.floor(Date.now() / 1000);

  const attempt = row.attempt + 1;
  const outcome = await span(
    'webhook.deliver',
    { 'webhook.delivery_id': deliveryId, 'webhook.event_type': event.type, 'webhook.attempt': attempt },
    () => post(row.url, body, { id: deliveryId, timestamp, secret: row.secret }),
  );

  if (outcome.ok) {
    await db()`
      update webhook_deliveries
      set status = 'delivered', attempt = ${attempt}, delivered_at = now(),
          last_status_code = ${outcome.status ?? null}, last_error = null,
          next_attempt_at = null
      where id = ${deliveryId}
    `;
    return 'delivered';
  }

  const nextDelay = RETRY_SCHEDULE_SECONDS[attempt - 1];

  if (nextDelay === undefined) {
    await db()`
      update webhook_deliveries
      set status = 'failed', attempt = ${attempt},
          last_status_code = ${outcome.status ?? null}, last_error = ${outcome.error},
          next_attempt_at = null
      where id = ${deliveryId}
    `;
    console.warn(
      JSON.stringify({
        msg: 'webhook delivery gave up',
        deliveryId,
        url: row.url,
        attempts: attempt,
        lastError: outcome.error,
      }),
    );
    return 'failed';
  }

  await db().begin(async (tx) => {
    await tx`
      update webhook_deliveries
      set status = 'pending', attempt = ${attempt},
          last_status_code = ${outcome.status ?? null}, last_error = ${outcome.error},
          next_attempt_at = now() + (${nextDelay} || ' seconds')::interval
      where id = ${deliveryId}
    `;
    // pg-boss has one retry delay per job, not a schedule, so each attempt
    // books the next one itself.
    await enqueue(tx, DELIVER_JOB, { deliveryId }, { startAfterSeconds: nextDelay });
  });

  return 'pending';
}

async function post(
  url: string,
  body: string,
  meta: { id: string; timestamp: number; secret: string },
): Promise<{ ok: boolean; status?: number; error: string | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': `marketing-engine/${process.env['npm_package_version'] ?? '0.1.0'}`,
        'webhook-id': meta.id,
        'webhook-timestamp': String(meta.timestamp),
        'webhook-signature': signPayload({
          secret: meta.secret,
          id: meta.id,
          timestamp: meta.timestamp,
          body,
        }),
      },
      body,
      signal: controller.signal,
    });

    return res.ok
      ? { ok: true, status: res.status, error: null }
      : { ok: false, status: res.status, error: `receiver answered ${res.status}` };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

/** Put a delivery back on the queue by hand, whatever state it ended in. */
export async function replay(tenantId: string, deliveryId: string): Promise<DeliveryRow> {
  const [owned] = await db()<DeliveryRow[]>`
    select d.* from webhook_deliveries d
    join webhook_endpoints e on e.id = d.endpoint_id
    where d.id = ${deliveryId} and e.tenant_id = ${tenantId}
  `;
  if (!owned) throw new WebhookError('not_found', 404, 'no such delivery');

  return db().begin(async (tx) => {
    const [row] = await tx<DeliveryRow[]>`
      update webhook_deliveries
      set status = 'pending', attempt = 0, next_attempt_at = now(), last_error = null
      where id = ${deliveryId}
      returning *
    `;
    await enqueue(tx, DELIVER_JOB, { deliveryId });
    return row!;
  }) as Promise<DeliveryRow>;
}
