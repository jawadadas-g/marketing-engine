import PgBoss from 'pg-boss';
import { db, type Tx } from '../db/client.js';
import { SEND_JOB } from '../modules/messaging/index.js';
import { processSend } from '../modules/messaging/worker.js';

/**
 * The queue. Modules call enqueue(); nothing else imports pg-boss.
 * pg-boss owns its own schema and creates it on first start.
 */
let boss: PgBoss | undefined;

const NOOP = 'noop';
const IDEMPOTENCY_CLEANUP = 'idempotency.cleanup';
const SEND_RETRY_LIMIT = 3;

/**
 * `registerWorkers: false` starts the queue without consuming anything, so a
 * test can assert what was enqueued.
 */
export async function startJobs(opts: { registerWorkers?: boolean } = {}): Promise<PgBoss> {
  if (boss) return boss;
  const registerWorkers = opts.registerWorkers ?? true;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set');

  const b = new PgBoss({ connectionString });
  b.on('error', (err) => console.error('pg-boss error', err));
  await b.start();

  await b.createQueue(NOOP);
  await b.createQueue(IDEMPOTENCY_CLEANUP);
  await b.createQueue(SEND_JOB);

  boss = b;
  if (!registerWorkers) return b;

  await b.work(NOOP, async () => {});

  await b.work(
    SEND_JOB,
    { includeMetadata: true },
    async (jobs) => {
      for (const job of jobs) {
        const { messageId } = job.data as { messageId: string };
        // pg-boss counts retries from 0, so this is the last attempt when the
        // count has reached the limit.
        await processSend(messageId, { finalAttempt: job.retryCount >= SEND_RETRY_LIMIT });
      }
    },
  );

  await b.work(IDEMPOTENCY_CLEANUP, async () => {
    // Runs as the owning role, which is not subject to the RLS policies, so one
    // statement sweeps every tenant.
    const deleted = await db()`
      delete from idempotency_keys where created_at < now() - interval '24 hours'
    `;
    if (deleted.count > 0) console.log(`idempotency.cleanup: deleted ${deleted.count} rows`);
  });
  await b.schedule(IDEMPOTENCY_CLEANUP, '0 * * * *');

  return b;
}

/**
 * Enqueue on the caller's transaction, so the job row commits with whatever
 * the caller was writing or not at all. A worker can never see a job whose
 * subject was rolled back.
 */
export async function enqueue(tx: Tx, name: string, data: object = {}): Promise<string | null> {
  if (!boss) throw new Error('jobs are not started');

  // The queue is infrastructure the API role does not own: marketing_app has
  // no rights in the pgboss schema, and giving it some would tie us to
  // pg-boss's table layout. Instead the owning role is resumed for the insert
  // and handed straight back, inside the one transaction. LOCAL throughout, so
  // a rollback undoes the job with everything else.
  const [current] = await tx<{ role: string }[]>`select current_user::text as role`;
  const asAppRole = current?.role === 'marketing_app';

  if (asAppRole) await tx`set local role none`;
  try {
    return await boss.send(name, data, {
      db: onTransaction(tx),
      ...(name === SEND_JOB ? { retryLimit: SEND_RETRY_LIMIT, retryBackoff: true } : {}),
    });
  } finally {
    if (asAppRole) await tx`set local role marketing_app`;
  }
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

export async function stopJobs(): Promise<void> {
  if (!boss) return;
  const b = boss;
  boss = undefined;
  await b.stop({ graceful: true });
}
