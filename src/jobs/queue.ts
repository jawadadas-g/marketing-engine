import PgBoss from 'pg-boss';
import { asOwner, type Tx } from '../db/client.js';
import { env } from '../env.js';

/**
 * The queue itself, with no knowledge of what runs on it. Separate from
 * `jobs/index.ts`, which registers the workers and therefore imports every
 * module: the event spine needs to enqueue, and would otherwise have to import
 * its own consumers.
 */
let boss: PgBoss | undefined;

export function queue(): PgBoss {
  if (!boss) throw new Error('jobs are not started');
  return boss;
}

export function queueStarted(): boolean {
  return boss !== undefined;
}

export async function openQueue(): Promise<PgBoss> {
  if (boss) return boss;
  const b = new PgBoss({ connectionString: env().DATABASE_URL });
  b.on('error', (err) => console.error('pg-boss error', err));
  await b.start();
  boss = b;
  return b;
}

export async function closeQueue(): Promise<void> {
  if (!boss) return;
  const b = boss;
  boss = undefined;
  await b.stop({ graceful: true });
}

export type EnqueueOptions = {
  retryLimit?: number;
  retryBackoff?: boolean;
  startAfterSeconds?: number;
};

/**
 * Enqueue on the caller's transaction, so the job row commits with whatever
 * the caller was writing or not at all. A worker can never see a job whose
 * subject was rolled back.
 */
export async function enqueue(
  tx: Tx,
  name: string,
  data: object = {},
  options: EnqueueOptions = {},
): Promise<string | null> {
  const b = queue();

  // The queue is infrastructure the API role does not own: marketing_app has
  // no rights in the pgboss schema, and giving it some would tie us to
  // pg-boss's table layout.
  return asOwner(tx, () =>
    b.send(name, data, {
      db: onTransaction(tx),
      ...(options.retryLimit !== undefined ? { retryLimit: options.retryLimit } : {}),
      ...(options.retryBackoff !== undefined ? { retryBackoff: options.retryBackoff } : {}),
      ...(options.startAfterSeconds !== undefined
        ? { startAfter: options.startAfterSeconds }
        : {}),
    }),
  );
}

/** pg-boss speaks to whatever exposes executeSql; hand it the open transaction. */
function onTransaction(tx: Tx): PgBoss.Db {
  return {
    async executeSql(text: string, values: unknown[]) {
      // pg-boss leaves optional parameters undefined; postgres.js rejects
      // those outright, so they become explicit nulls.
      const params = values.map((v) => (v === undefined ? null : v));
      const rows = await tx.unsafe(text, params as never[]);
      return { rows: rows as unknown[] };
    },
  };
}
