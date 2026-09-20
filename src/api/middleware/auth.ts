import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import { jwtVerify } from 'jose';
import { z } from 'zod';

export type AuthVars = { Variables: { tenantId: string } };

const claims = z.object({ tenant_id: z.string().uuid() });

let secret: Uint8Array | undefined;
function jwtSecret(): Uint8Array {
  if (!secret) {
    const raw = process.env.JWT_SECRET;
    if (!raw) throw new Error('JWT_SECRET is not set');
    secret = new TextEncoder().encode(raw);
  }
  return secret;
}

/** Verify the Bearer JWT and put its tenant on the context. 401 on anything else. */
export const auth = createMiddleware<AuthVars>(async (c, next) => {
  const header = c.req.header('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) throw new HTTPException(401, { message: 'missing bearer token' });

  let payload: unknown;
  try {
    ({ payload } = await jwtVerify(token, jwtSecret(), { algorithms: ['HS256'] }));
  } catch {
    throw new HTTPException(401, { message: 'invalid token' });
  }

  const parsed = claims.safeParse(payload);
  if (!parsed.success) throw new HTTPException(401, { message: 'token has no tenant_id claim' });

  c.set('tenantId', parsed.data.tenant_id);
  await next();
});
