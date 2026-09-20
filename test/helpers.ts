import { SignJWT } from 'jose';
import { closeDb, db } from '../src/db/client.js';
import { migrate } from '../src/db/migrate.js';

export const TENANT_A = '11111111-1111-1111-1111-111111111111';
export const TENANT_B = '22222222-2222-2222-2222-222222222222';

/**
 * Migrate, then reset to two known tenants. Runs as the owner, so no RLS.
 *
 * The tenants themselves are kept rather than truncated: `truncate tenants
 * cascade` would follow the foreign keys into `rules` and take the seeded
 * region rule with it, and the seed only runs once.
 */
export async function resetDb(): Promise<void> {
  await migrate();
  await db()`delete from rules where scope = 'tenant'`;
  await db()`truncate idempotency_keys, events, consent, suppression restart identity`;
  await db()`
    insert into tenants (id, name) values
      (${TENANT_A}, 'Tenant A'),
      (${TENANT_B}, 'Tenant B')
    on conflict (id) do nothing
  `;
}

export async function teardownDb(): Promise<void> {
  await closeDb();
}

export async function tokenFor(tenantId: string): Promise<string> {
  const secret = new TextEncoder().encode(process.env.JWT_SECRET!);
  return new SignJWT({ tenant_id: tenantId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(secret);
}
