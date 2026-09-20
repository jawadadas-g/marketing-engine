import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { adapterFor } from '../../modules/messaging/adapters/index.js';
import { applyDeliveryReport } from '../../modules/messaging/worker.js';

export const webhooks = new Hono();

/**
 * Provider delivery reports. No JWT: a provider has none. Taqnyat cannot sign
 * its callbacks, so the URL itself is the secret and a wrong token is a 404 —
 * the same answer an unknown path gets, which tells a prober nothing.
 */
webhooks.post('/webhooks/:provider/:token', async (c) => {
  const expected = process.env.WEBHOOK_TOKEN;
  if (!expected || !tokenMatches(c.req.param('token'), expected)) {
    return c.json({ error: 'not found' }, 404);
  }

  const adapter = adapterFor(c.req.param('provider'));
  if (!adapter) return c.json({ error: 'not found' }, 404);

  const body = await c.req.json().catch(() => null);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(c.req.header())) headers[k.toLowerCase()] = v;

  let reports;
  try {
    reports = adapter.parseWebhook({ headers, body });
  } catch (err) {
    // A body we cannot parse is still accepted: a 4xx makes providers retry
    // the same unparseable thing forever.
    console.warn(`webhook: ${adapter.provider} body could not be parsed`, err, body);
    return c.body(null, 202);
  }

  for (const report of reports) {
    await applyDeliveryReport({ provider: adapter.provider, ...report });
  }

  return c.body(null, 202);
});

function tokenMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
