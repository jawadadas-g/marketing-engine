import postgres from 'postgres';

export type Sql = postgres.Sql<{}>;
export type Tx = postgres.TransactionSql<{}>;

function connectionString(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  return url;
}

let pool: Sql | undefined;

/** The one connection pool. */
export function db(): Sql {
  pool ??= postgres(connectionString(), { max: 10, onnotice: () => {} });
  return pool;
}

export async function closeDb(): Promise<void> {
  if (!pool) return;
  const p = pool;
  pool = undefined;
  await p.end();
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
