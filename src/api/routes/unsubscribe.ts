import { Hono } from 'hono';
import { db } from '../../db/client.js';
import { record, suppress } from '../../spine/consent/index.js';
import type { Channel } from '../../spine/contacts/normalize.js';
import { verifyUnsubscribeToken } from '../../modules/messaging/unsubscribe.js';

export const unsubscribe = new Hono();

/**
 * One-click unsubscribe from an email's List-Unsubscribe header. No JWT: the
 * signed token is the authority, and it names the tenant, channel and address.
 * Runs as the owning role because the recipient has no session.
 */
async function optOut(token: string): Promise<boolean> {
  const claim = verifyUnsubscribeToken(token);
  if (!claim) return false;

  await db().begin(async (tx) => {
    await suppress(tx, {
      tenantId: claim.tenantId,
      channel: claim.channel as Channel,
      address: claim.address,
      reason: 'unsubscribe',
    });
    await record(tx, {
      tenantId: claim.tenantId,
      channel: claim.channel as Channel,
      address: claim.address,
      purpose: 'marketing',
      status: 'revoked',
      source: 'list-unsubscribe',
    });
  });

  return true;
}

// Mail clients acting on List-Unsubscribe-Post send this one.
unsubscribe.post('/unsubscribe/:token', async (c) =>
  (await optOut(c.req.param('token')))
    ? c.json({ unsubscribed: true })
    : c.json({ error: 'not found' }, 404),
);

// Some clients just open the link, so the same thing has to work on a GET.
unsubscribe.get('/unsubscribe/:token', async (c) =>
  (await optOut(c.req.param('token')))
    ? c.text('You have been unsubscribed.')
    : c.text('This unsubscribe link is not valid.', 404),
);
