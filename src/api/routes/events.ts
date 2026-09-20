import { Hono } from 'hono';
import { z } from 'zod';
import { withTenant } from '../../db/client.js';
import { emit, list } from '../../spine/events/index.js';
import type { AuthVars } from '../middleware/auth.js';

const emitBody = z.object({
  type: z.string().min(1).max(200),
  subjectType: z.string().min(1).max(200).optional(),
  subjectId: z.string().min(1).max(200).optional(),
  payload: z.record(z.unknown()).optional(),
});

const listQuery = z.object({
  type: z.string().min(1).max(200).optional(),
  since: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
});

export const events = new Hono<AuthVars>();

events.post('/v1/events', async (c) => {
  const parsed = emitBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid body', detail: parsed.error.issues }, 400);

  const tenantId = c.get('tenantId');
  const row = await withTenant(tenantId, (tx) => emit(tx, { tenantId, ...parsed.data }));

  return c.json({ event: serialise(row) }, 201);
});

events.get('/v1/events', async (c) => {
  const parsed = listQuery.safeParse(c.req.query());
  if (!parsed.success) return c.json({ error: 'invalid query', detail: parsed.error.issues }, 400);

  const tenantId = c.get('tenantId');
  const rows = await withTenant(tenantId, (tx) => list(tx, { tenantId, ...parsed.data }));

  return c.json({ events: rows.map(serialise) });
});

function serialise(row: {
  id: string;
  type: string;
  subject_type: string | null;
  subject_id: string | null;
  payload: unknown;
  occurred_at: Date;
}) {
  return {
    id: String(row.id),
    type: row.type,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    payload: row.payload,
    occurredAt: row.occurred_at.toISOString(),
  };
}
