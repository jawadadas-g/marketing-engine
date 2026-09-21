import { Hono } from 'hono';
import { z } from 'zod';
import { db, withTenant } from '../../db/client.js';
import {
  createEndpoint,
  redactEndpoint,
  replay,
  type DeliveryRow,
  type EndpointRow,
} from '../../modules/webhooks/index.js';
import type { AuthVars } from '../middleware/auth.js';

export const webhookEndpoints = new Hono<AuthVars>();

webhookEndpoints.post('/v1/webhooks', async (c) => {
  const parsed = z
    .object({ url: z.string().min(1), eventTypes: z.array(z.string().min(1)).max(100).optional() })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid body', detail: parsed.error.issues }, 400);

  const tenantId = c.get('tenantId');
  const created = await withTenant(tenantId, (tx) =>
    createEndpoint(tx, { tenantId, ...parsed.data }),
  );

  // The secret is shown once, here. It is not retrievable afterwards; losing it
  // means creating a new endpoint.
  return c.json({ webhook: redactEndpoint(created.endpoint), secret: created.secret }, 201);
});

webhookEndpoints.get('/v1/webhooks', async (c) => {
  const rows = await withTenant(
    c.get('tenantId'),
    (tx) => tx<EndpointRow[]>`select * from webhook_endpoints order by created_at desc`,
  );
  return c.json({ webhooks: rows.map(redactEndpoint) });
});

webhookEndpoints.delete('/v1/webhooks/:id', async (c) => {
  const id = z.string().uuid().safeParse(c.req.param('id'));
  if (!id.success) return c.json({ error: 'not found' }, 404);

  const deleted = await withTenant(
    c.get('tenantId'),
    (tx) => tx`delete from webhook_endpoints where id = ${id.data}`,
  );
  return deleted.count > 0 ? c.body(null, 204) : c.json({ error: 'not found' }, 404);
});

webhookEndpoints.get('/v1/webhooks/:id/deliveries', async (c) => {
  const id = z.string().uuid().safeParse(c.req.param('id'));
  if (!id.success) return c.json({ error: 'not found' }, 404);
  const status = c.req.query('status');

  const rows = await withTenant(
    c.get('tenantId'),
    (tx) => tx<DeliveryRow[]>`
      select d.* from webhook_deliveries d
      where d.endpoint_id = ${id.data}
        ${status ? tx`and d.status = ${status}` : tx``}
      order by d.id desc
      limit 200
    `,
  );
  return c.json({ deliveries: rows });
});

webhookEndpoints.post('/v1/webhooks/:id/deliveries/:deliveryId/replay', async (c) => {
  const deliveryId = c.req.param('deliveryId');
  const row = await replay(c.get('tenantId'), deliveryId);
  return c.json({ delivery: row }, 202);
});

/** Used by /health to say whether the queue is up. */
export async function queueState(): Promise<string> {
  try {
    const [row] = await db()`
      select count(*)::text as pending from pgboss.job where state = 'created'
    `;
    return row ? `running (${(row as { pending: string }).pending} queued)` : 'running';
  } catch {
    return 'unavailable';
  }
}
