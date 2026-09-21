import { createHash } from 'node:crypto';
import { createMiddleware } from 'hono/factory';
import { withTenant } from '../../db/client.js';
import type { AuthVars } from './auth.js';

type Stored = {
  response_hash: string;
  response_body: string;
  status: number;
  request_hash: string | null;
};

/**
 * Routes where a retry without a key could take money or send a message twice,
 * so the key is required rather than optional.
 */
const KEY_REQUIRED = [/^\/v1\/redemptions$/, /^\/v1\/redemptions\/[^/]+\/(settle|release)$/];

/**
 * Replay the stored response when the same tenant repeats an Idempotency-Key.
 * Only successful (2xx) responses are stored, so a failed call can be retried.
 * Rows are dropped after 24h by the `idempotency.cleanup` cron.
 */
export const idempotency = createMiddleware<AuthVars>(async (c, next) => {
  const key = c.req.header('Idempotency-Key');
  const replayable = c.req.method === 'POST' || c.req.method === 'PUT';
  if (!replayable) return next();

  if (!key) {
    return KEY_REQUIRED.some((route) => route.test(c.req.path))
      ? c.json(
          {
            error: 'idempotency_key_required',
            message: 'this route needs an Idempotency-Key header',
          },
          400,
        )
      : next();
  }

  const tenantId = c.get('tenantId');
  const requestHash = hash(await c.req.text());

  const [stored] = await withTenant(tenantId, (tx) =>
    tx<Stored[]>`
      select response_hash, response_body, status, request_hash
      from idempotency_keys
      where tenant_id = ${tenantId} and key = ${key}
    `,
  );

  if (stored) {
    // The same key with a different body is a bug on the caller's side, and
    // answering it with the first call's response would hide it.
    if (stored.request_hash && stored.request_hash !== requestHash) {
      return c.json(
        {
          error: 'idempotency_key_reused',
          message: 'this Idempotency-Key was used for a different request body',
        },
        422,
      );
    }

    return c.newResponse(stored.response_body, stored.status as 200, {
      'Content-Type': 'application/json',
      'Idempotency-Replayed': 'true',
      'Idempotency-Hash': stored.response_hash,
    });
  }

  await next();

  if (c.res.status < 200 || c.res.status >= 300) return;

  const body = await c.res.clone().text();
  const status = c.res.status;

  // ON CONFLICT DO NOTHING: two concurrent first-calls both run the handler,
  // and the loser's row is dropped rather than overwriting the winner's.
  await withTenant(tenantId, (tx) =>
    tx`
      insert into idempotency_keys
        (tenant_id, key, response_hash, response_body, status, request_hash)
      values (${tenantId}, ${key}, ${hash(body)}, ${body}, ${status}, ${requestHash})
      on conflict (tenant_id, key) do nothing
    `,
  );
});

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
