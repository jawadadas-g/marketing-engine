import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { db, withTenant } from '../../db/client.js';
import { env } from '../../env.js';
import { emit } from '../../spine/events/index.js';
import { createEndpoint, redactEndpoint } from '../../modules/webhooks/index.js';

/**
 * The marketplace's own routes. Authenticated with the shared internal token,
 * not a tenant JWT: these calls create the tenants that JWTs refer to, so they
 * cannot be scoped by one.
 */
export const internal = new Hono();

export function internalTokenMatches(given: string): boolean {
  const expected = env().INTERNAL_TOKEN;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

internal.use('/internal/*', async (c, next) => {
  if (!internalTokenMatches(c.req.header('X-Internal-Token') ?? '')) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  await next();
});

type TenantRow = { id: string; name: string; external_ref: string | null; created_at: Date };

internal.post('/internal/tenants', async (c) => {
  const parsed = z
    .object({ name: z.string().min(1).max(200), externalRef: z.string().min(1).max(200) })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid body', detail: parsed.error.issues }, 400);

  // Provisioning is idempotent on the marketplace's own id: asking twice gets
  // the same tenant, because the marketplace will retry.
  const [existing] = await db()<TenantRow[]>`
    select * from tenants where external_ref = ${parsed.data.externalRef}
  `;
  if (existing) return c.json({ tenantId: existing.id, name: existing.name }, 200);

  const [row] = await db()<TenantRow[]>`
    insert into tenants (id, name, external_ref)
    values (gen_random_uuid(), ${parsed.data.name}, ${parsed.data.externalRef})
    returning *
  `;

  await withTenant(row!.id, (tx) =>
    emit(tx, {
      tenantId: row!.id,
      type: 'tenant.created',
      subjectType: 'tenant',
      subjectId: row!.id,
      payload: { name: row!.name, externalRef: parsed.data.externalRef },
    }),
  );

  return c.json({ tenantId: row!.id, name: row!.name }, 201);
});

/** The platform endpoint: hears every tenant's events, belongs to none. */
internal.post('/internal/webhooks', async (c) => {
  const parsed = z
    .object({ url: z.string().min(1), eventTypes: z.array(z.string().min(1)).max(100).optional() })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid body', detail: parsed.error.issues }, 400);

  const created = await db().begin((tx) =>
    createEndpoint(tx as never, { tenantId: null, ...parsed.data }),
  );

  return c.json(
    { webhook: redactEndpoint(created.endpoint), secret: created.secret },
    201,
  );
});
