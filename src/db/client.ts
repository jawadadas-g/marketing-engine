import postgres from 'postgres';
import { env } from '../env.js';

export type Sql = postgres.Sql<{}>;
export type Tx = postgres.TransactionSql<{}>;

function connectionString(): string {
  return env().DATABASE_URL;
}

let pool: Sql | undefined;

/** The one connection pool. */
export function db(): Sql {
  pool ??= postgres(connectionString(), {
    max: 10,
    onnotice: () => {},
    // Everything the engine owns lives in `marketing`, so no query names the
    // schema. `public` stays on the path for extension functions.
    connection: { search_path: 'marketing, public' },
  });
  return pool;
}

export async function closeDb(): Promise<void> {
  if (!pool) return;
  const p = pool;
  pool = undefined;
  await p.end();
}

/**
 * Run `fn` with the owning role, inside the caller's transaction, then hand the
 * role straight back.
 *
 * For the few operations that are the platform's rather than a tenant's: the
 * queue, which the API role has no rights on, and a registry merge, which
 * rewrites pool-wide bookkeeping including rows belonging to other tenants. It
 * is LOCAL throughout, so a rollback undoes everything with it.
 */
export async function asOwner<T>(tx: Tx, fn: () => Promise<T>): Promise<T> {
  const [current] = await tx<{ role: string }[]>`select current_user::text as role`;
  const escalate = current?.role === 'marketing_app';

  if (escalate) await tx`set local role none`;
  try {
    return await fn();
  } finally {
    if (escalate) await tx`set local role marketing_app`;
  }
}

/**
 * Run `fn` in a transaction scoped to one tenant.
 *
 * Both settings are LOCAL, so they are dropped when the transaction ends and
 * the pooled connection goes back clean. The role switch is what makes the RLS
 * policies apply: the connection's own role owns the tables and would otherwise
 * bypass them.
 */
export async function withTenant<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db().begin(async (tx) => {
    await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
    await tx`set local role marketing_app`;
    return fn(tx);
  }) as Promise<T>;
}
