import { Hono } from 'hono';
import { z } from 'zod';
import { withTenant } from '../../db/client.js';
import { canSend, record, suppress } from '../../spine/consent/index.js';
import { CHANNELS, PURPOSES } from '../../spine/contacts/normalize.js';
import type { AuthVars } from '../middleware/auth.js';

const channel = z.enum(CHANNELS);
const purpose = z.enum(PURPOSES);
const defaultCountry = z.string().length(2).optional();

const consentBody = z.object({
  channel,
  address: z.string().min(1),
  purpose,
  status: z.enum(['granted', 'revoked']),
  source: z.string().min(1).max(200),
  defaultCountry,
});

const suppressionBody = z.object({
  channel,
  address: z.string().min(1),
  reason: z.string().min(1).max(200),
  defaultCountry,
});

const canSendQuery = z.object({
  channel,
  address: z.string().min(1),
  purpose,
  at: z.coerce.date().optional(),
  defaultCountry,
});

export const consent = new Hono<AuthVars>();

consent.post('/v1/consent', async (c) => {
  const parsed = consentBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid body', detail: parsed.error.issues }, 400);

  const tenantId = c.get('tenantId');
  const row = await withTenant(tenantId, (tx) => record(tx, { tenantId, ...parsed.data }));
  return c.json({ consent: row }, 201);
});

consent.post('/v1/suppression', async (c) => {
  const parsed = suppressionBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid body', detail: parsed.error.issues }, 400);

  const tenantId = c.get('tenantId');
  const row = await withTenant(tenantId, (tx) => suppress(tx, { tenantId, ...parsed.data }));
  return c.json({ suppression: row }, 201);
});

consent.get('/v1/can-send', async (c) => {
  const parsed = canSendQuery.safeParse(c.req.query());
  if (!parsed.success) return c.json({ error: 'invalid query', detail: parsed.error.issues }, 400);

  const tenantId = c.get('tenantId');
  const result = await withTenant(tenantId, (tx) => canSend(tx, { tenantId, ...parsed.data }));
  return c.json(result);
});
