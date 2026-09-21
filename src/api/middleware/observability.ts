import { randomUUID } from 'node:crypto';
import { createMiddleware } from 'hono/factory';
import { currentTraceId, span } from '../../otel.js';

export type RequestVars = { Variables: { requestId: string } };

/**
 * One JSON line per request and one span around it. No logging library: a
 * line is an object and `console.log` writes it.
 *
 * The request id comes from the caller when it sends one, so a trace through
 * the marketplace and the engine shares an identifier, and is echoed back
 * either way.
 */
export const observability = createMiddleware<RequestVars>(async (c, next) => {
  const requestId = c.req.header('X-Request-Id') ?? randomUUID();
  c.set('requestId', requestId);
  c.header('X-Request-Id', requestId);

  const startedAt = Date.now();
  const method = c.req.method;
  const path = c.req.path;

  await span('http', { 'http.method': method, 'http.route': path, 'request.id': requestId }, () =>
    next(),
  );

  const traceId = currentTraceId();
  console.log(
    JSON.stringify({
      msg: 'request',
      method,
      path,
      status: c.res.status,
      // Set by the auth middleware when there was a token; absent otherwise.
      tenantId: (c.get as (k: string) => string | undefined)('tenantId') ?? null,
      durationMs: Date.now() - startedAt,
      requestId,
      ...(traceId ? { traceId } : {}),
    }),
  );
});
