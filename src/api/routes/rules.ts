import { Hono } from 'hono';
import { z } from 'zod';
import { withTenant } from '../../db/client.js';
import { createTenantRule, deleteTenantRule, listForTenant } from '../../spine/rules/index.js';
import type { AuthVars } from '../middleware/auth.js';

// One kind in v1. channel_selection arrives with step 4.
const KINDS = ['sending_window'] as const;

const createBody = z.object({
  kind: z.enum(KINDS),
  name: z.string().min(1).max(200),
  document: z.record(z.unknown()),
});

export const rules = new Hono<AuthVars>();

rules.get('/v1/rules', async (c) => {
  const rows = await withTenant(c.get('tenantId'), listForTenant);
  return c.json({ rules: rows });
});

rules.post('/v1/rules', async (c) => {
  const parsed = createBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid body', detail: parsed.error.issues }, 400);

  const tenantId = c.get('tenantId');
  const row = await withTenant(tenantId, (tx) =>
    createTenantRule(tx, { tenantId, ...parsed.data }),
  );
  return c.json({ rule: row }, 201);
});

rules.delete('/v1/rules/:id', async (c) => {
  const id = z.string().uuid().safeParse(c.req.param('id'));
  if (!id.success) return c.json({ error: 'not found' }, 404);

  // The RLS delete policy only matches this tenant's own rules, so a platform
  // or region rule deletes nothing and reads as a 404.
  const deleted = await withTenant(c.get('tenantId'), (tx) => deleteTenantRule(tx, id.data));
  return deleted ? c.body(null, 204) : c.json({ error: 'not found' }, 404);
});
