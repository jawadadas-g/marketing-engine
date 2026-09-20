import PgBoss from 'pg-boss';
import { db } from '../db/client.js';

/**
 * The queue. Modules call enqueue(); nothing else imports pg-boss.
 * pg-boss owns its own schema and creates it on first start.
 */
let boss: PgBoss | undefined;

const NOOP = 'noop';
const IDEMPOTENCY_CLEANUP = 'idempotency.cleanup';

export async function startJobs(): Promise<PgBoss> {
  if (boss) return boss;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set');

  const b = new PgBoss({ connectionString });
  b.on('error', (err) => console.error('pg-boss error', err));
  await b.start();

  await b.createQueue(NOOP);
  await b.work(NOOP, async () => {});

  await b.createQueue(IDEMPOTENCY_CLEANUP);
  await b.work(IDEMPOTENCY_CLEANUP, async () => {
    // Runs as the owning role, which is not subject to the RLS policies, so one
    // statement sweeps every tenant.
    const deleted = await db()`
      delete from idempotency_keys where created_at < now() - interval '24 hours'
    `;
    if (deleted.count > 0) console.log(`idempotency.cleanup: deleted ${deleted.count} rows`);
  });
  await b.schedule(IDEMPOTENCY_CLEANUP, '0 * * * *');

  boss = b;
  return b;
}

export async function enqueue(name: string, data: object = {}): Promise<string | null> {
  if (!boss) throw new Error('jobs are not started');
  return boss.send(name, data);
}

export async function stopJobs(): Promise<void> {
  if (!boss) return;
  const b = boss;
  boss = undefined;
  await b.stop({ graceful: true });
}
