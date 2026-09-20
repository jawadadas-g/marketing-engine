import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { db } from '../../db/client.js';
import {
  adaptersForProvider,
  WebhookAuthError,
  type ProviderConfig,
} from '../../modules/messaging/adapters/index.js';
import { openConfig, type ChannelConfigRow } from '../../modules/messaging/index.js';
import { applyInbound, applyStatusReport } from '../../modules/messaging/worker.js';

export const webhooks = new Hono();

/**
 * Meta's subscription handshake: it GETs the callback URL once and expects the
 * challenge echoed back in plain text.
 */
webhooks.get('/webhooks/:provider/:token', (c) => {
  if (c.req.param('provider') !== 'whatsapp-meta') return c.json({ error: 'not found' }, 404);
  if (!tokenMatches(c.req.param('token'))) return c.json({ error: 'not found' }, 404);

  const query = c.req.query();
  if (query['hub.mode'] !== 'subscribe' || !tokenMatches(query['hub.verify_token'] ?? '')) {
    return c.json({ error: 'not found' }, 404);
  }
  return c.text(query['hub.challenge'] ?? '');
});

/**
 * Provider callbacks. No JWT: a provider has none, so the URL itself carries a
 * shared secret and a wrong one is a 404, the same answer an unknown path gets.
 * Providers that sign their payloads are checked properly on top of that.
 */
webhooks.post('/webhooks/:provider/:token', async (c) => {
  if (!tokenMatches(c.req.param('token'))) return c.json({ error: 'not found' }, 404);

  const provider = c.req.param('provider');
  const candidates = adaptersForProvider(provider);
  if (candidates.length === 0) return c.json({ error: 'not found' }, 404);

  const rawBody = await c.req.text();
  let body: unknown = null;
  try {
    body = rawBody ? JSON.parse(rawBody) : null;
  } catch {
    console.warn(`webhook: ${provider} sent a body that is not JSON`);
    return c.body(null, 202);
  }

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(c.req.header())) headers[k.toLowerCase()] = v;

  for (const adapter of candidates) {
    const request = { headers, body, rawBody };

    // A provider that signs per tenant needs that tenant's secret before the
    // signature can be checked, and the payload is the only thing that says
    // which tenant it is.
    let config: ProviderConfig | undefined;
    if (adapter.webhookNeedsConfig) {
      const hint = adapter.tenantHint?.(request);
      if (!hint) continue;
      config = await configByHint(provider, hint.configKey, hint.value);
      if (!config) {
        console.warn(`webhook: ${provider} callback for an unknown ${hint.configKey}`);
        return c.body(null, 202);
      }
    }

    let events;
    try {
      events = adapter.parseWebhook({ ...request, config });
    } catch (err) {
      if (err instanceof WebhookAuthError) return c.json({ error: 'unauthorized' }, err.status);
      // A body we cannot parse is still accepted: a 4xx makes providers retry
      // the same unparseable thing forever.
      console.warn(`webhook: ${provider} body could not be parsed`, err);
      return c.body(null, 202);
    }

    if (events.length === 0) continue;

    for (const event of events) {
      if (event.kind === 'status') {
        await applyStatusReport({ provider, ...event });
      } else {
        await applyInbound({ provider, channel: adapter.channel, ...event });
      }
    }
    return c.body(null, 202);
  }

  return c.body(null, 202);
});

/**
 * Find the tenant a signed callback belongs to, by a value the payload carries
 * (Meta's phone_number_id). Runs as the owning role: there is no tenant yet.
 */
async function configByHint(
  provider: string,
  configKey: string,
  value: string,
): Promise<ProviderConfig | undefined> {
  const rows = await db()<ChannelConfigRow[]>`
    select * from tenant_channel_configs where provider = ${provider}
  `;
  for (const row of rows) {
    const config = openConfig(row);
    if (config[configKey] === value) return config;
  }
  return undefined;
}

function tokenMatches(given: string): boolean {
  const expected = process.env.WEBHOOK_TOKEN ?? '';
  if (!expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
