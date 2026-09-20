import { createHash } from 'node:crypto';
import { createMiddleware } from 'hono/factory';
import { withTenant } from '../../db/client.js';
import type { AuthVars } from './auth.js';

type Stored = { response_hash: string; response_body: string; status: number };

/**
 * Replay the stored response when the same tenant repeats an Idempotency-Key.
 * Only successful (2xx) responses are stored, so a failed call can be retried.
 * Rows are dropped after 24h by the `idempotency.cleanup` cron.
 */
export const idempotency = createMiddleware<AuthVars>(async (c, next) => {
  const key = c.req.header('Idempotency-Key');
  const replayable = c.req.method === 'POST' || c.req.method === 'PUT';
  if (!key || !replayable) return next();

  const tenantId = c.get('tenantId');

  const [stored] = await withTenant(tenantId, (tx) =>
    tx<Stored[]>`
      select response_hash, response_body, status
      from idempotency_keys
      where tenant_id = ${tenantId} and key = ${key}
    `,
  );

  if (stored) {
    return c.newResponse(stored.response_body, stored.status as 200, {
      'Content-Type': 'application/json',
      'Idempotency-Replayed': 'true',
      'Idempotency-Hash': stored.response_hash,
    });
  }

  await next();

  if (c.res.status < 200 || c.res.status >= 300) return;

  const body = await c.res.clone().text();
  const hash = createHash('sha256').update(body).digest('hex');
  const status = c.res.status;

  // ON CONFLICT DO NOTHING: two concurrent first-calls both run the handler,
  // and the loser's row is dropped rather than overwriting the winner's.
  await withTenant(tenantId, (tx) =>
    tx`
      insert into idempotency_keys (tenant_id, key, response_hash, response_body, status)
      values (${tenantId}, ${key}, ${hash}, ${body}, ${status})
      on conflict (tenant_id, key) do nothing
    `,
  );
});
