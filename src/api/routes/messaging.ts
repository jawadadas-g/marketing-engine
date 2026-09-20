import { Hono } from 'hono';
import { z } from 'zod';
import { withTenant } from '../../db/client.js';
import {
  getChannelConfig,
  redactConfig,
  send,
  storeChannelConfig,
  upsertTemplate,
  validateChannelConfig,
  type MessageRow,
} from '../../modules/messaging/index.js';
import { CHANNELS, PURPOSES } from '../../spine/contacts/normalize.js';
import type { AuthVars } from '../middleware/auth.js';

const channel = z.enum(CHANNELS);

const channelConfigBody = z.object({
  provider: z.string().min(1).max(50),
  sender: z.string().min(1).max(50),
  unsubscribeText: z.string().min(1).max(200).optional(),
  config: z.record(z.unknown()),
});

const templateBody = z.object({
  channel,
  body: z.string().min(1).max(5000),
});

const sendBody = z.object({
  channel,
  address: z.string().min(1),
  purpose: z.enum(PURPOSES),
  template: z.string().min(1).max(200),
  variables: z.record(z.unknown()).optional(),
  defaultCountry: z.string().length(2).optional(),
  at: z.coerce.date().optional(),
});

export const messaging = new Hono<AuthVars>();

messaging.put('/v1/channels/:channel', async (c) => {
  const ch = channel.safeParse(c.req.param('channel'));
  if (!ch.success) return c.json({ error: 'unknown channel' }, 404);

  const parsed = channelConfigBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid body', detail: parsed.error.issues }, 400);

  const tenantId = c.get('tenantId');

  // Validate first: this talks to the provider over HTTP, and holding a
  // transaction open across that round trip pins a connection for its latency.
  await validateChannelConfig({ channel: ch.data, ...parsed.data });

  const row = await withTenant(tenantId, (tx) =>
    storeChannelConfig(tx, { tenantId, channel: ch.data, ...parsed.data }),
  );
  return c.json({ channel: redactConfig(row) });
});

messaging.get('/v1/channels/:channel', async (c) => {
  const ch = channel.safeParse(c.req.param('channel'));
  if (!ch.success) return c.json({ error: 'unknown channel' }, 404);

  const row = await withTenant(c.get('tenantId'), (tx) => getChannelConfig(tx, ch.data));
  return row ? c.json({ channel: redactConfig(row) }) : c.json({ error: 'not found' }, 404);
});

messaging.put('/v1/templates/:name', async (c) => {
  const parsed = templateBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid body', detail: parsed.error.issues }, 400);

  const tenantId = c.get('tenantId');
  const name = c.req.param('name');
  const row = await withTenant(tenantId, (tx) =>
    upsertTemplate(tx, { tenantId, name, ...parsed.data }),
  );
  return c.json({ template: { name: row.name, channel: row.channel, body: row.body } });
});

messaging.post('/v1/messages', async (c) => {
  const parsed = sendBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid body', detail: parsed.error.issues }, 400);

  const tenantId = c.get('tenantId');
  const row = await withTenant(tenantId, (tx) => send(tx, { tenantId, ...parsed.data }));

  // 202 when it is on the queue, 200 when can_send refused and nothing will go.
  return c.json({ message: serialise(row) }, row.status === 'queued' ? 202 : 200);
});

messaging.get('/v1/messages/:id', async (c) => {
  const id = z.string().uuid().safeParse(c.req.param('id'));
  if (!id.success) return c.json({ error: 'not found' }, 404);

  const [row] = await withTenant(
    c.get('tenantId'),
    (tx) => tx<MessageRow[]>`select * from messages where id = ${id.data}`,
  );
  return row ? c.json({ message: serialise(row) }) : c.json({ error: 'not found' }, 404);
});

function serialise(row: MessageRow) {
  return {
    id: row.id,
    channel: row.channel,
    address: row.address,
    region: row.region,
    purpose: row.purpose,
    template: row.template_name,
    body: row.body,
    status: row.status,
    provider: row.provider,
    providerMessageId: row.provider_message_id,
    blockedReason: row.blocked_reason,
    error: row.error,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
