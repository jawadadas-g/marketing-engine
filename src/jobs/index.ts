import type PgBoss from 'pg-boss';
import { db } from '../db/client.js';
import { SEND_JOB, SEND_RETRY_LIMIT } from '../modules/messaging/index.js';
import { processSend } from '../modules/messaging/worker.js';
import { EXPIRE_JOB, expireReservations } from '../modules/promocodes/index.js';
import { DELIVER_JOB, FANOUT_JOB, deliver, fanOut } from '../modules/webhooks/index.js';
import { span } from '../otel.js';
import { closeQueue, openQueue, queueStarted } from './queue.js';

export { enqueue } from './queue.js';

const NOOP = 'noop';
const IDEMPOTENCY_CLEANUP = 'idempotency.cleanup';

/**
 * Register every worker. `registerWorkers: false` starts the queue without
 * consuming anything, so a test can assert what was enqueued.
 */
export async function startJobs(opts: { registerWorkers?: boolean } = {}): Promise<PgBoss> {
  if (queueStarted()) return openQueue();
  const registerWorkers = opts.registerWorkers ?? true;

  const b = await openQueue();

  for (const name of [NOOP, IDEMPOTENCY_CLEANUP, SEND_JOB, EXPIRE_JOB, FANOUT_JOB, DELIVER_JOB]) {
    await b.createQueue(name);
  }

  if (!registerWorkers) return b;

  await b.work(NOOP, async () => {});

  await b.work(SEND_JOB, { includeMetadata: true }, async (jobs) => {
    for (const job of jobs) {
      const { messageId } = job.data as { messageId: string };
      await withJobLog(SEND_JOB, job.id, () =>
        // pg-boss counts retries from 0, so this is the last attempt when the
        // count has reached the limit.
        processSend(messageId, { finalAttempt: job.retryCount >= SEND_RETRY_LIMIT }),
      );
    }
  });

  await b.work(FANOUT_JOB, async (jobs) => {
    for (const job of jobs) {
      const { eventId } = job.data as { eventId: string };
      await withJobLog(FANOUT_JOB, job.id, () => fanOut(eventId));
    }
  });

  await b.work(DELIVER_JOB, async (jobs) => {
    for (const job of jobs) {
      const { deliveryId } = job.data as { deliveryId: string };
      await withJobLog(DELIVER_JOB, job.id, () => deliver(deliveryId));
    }
  });

  await b.work(IDEMPOTENCY_CLEANUP, async () => {
    // Runs as the owning role, which is not subject to the RLS policies, so one
    // statement sweeps every tenant.
    const deleted = await db()`
      delete from idempotency_keys where created_at < now() - interval '24 hours'
    `;
    if (deleted.count > 0) console.log(`idempotency.cleanup: deleted ${deleted.count} rows`);
  });
  await b.schedule(IDEMPOTENCY_CLEANUP, '0 * * * *');

  await b.work(EXPIRE_JOB, async () => {
    // A cart abandoned at checkout must not hold budget open against every
    // other buyer forever.
    const released = await expireReservations();
    if (released > 0) console.log(`${EXPIRE_JOB}: released ${released} expired reservations`);
  });
  await b.schedule(EXPIRE_JOB, '*/5 * * * *');

  return b;
}

/** One line per job, and one span, whatever the outcome. */
async function withJobLog<T>(name: string, id: string, fn: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  try {
    const result = await span('job', { 'job.name': name, 'job.id': id }, fn);
    console.log(JSON.stringify({ msg: 'job', name, id, durationMs: Date.now() - startedAt, ok: true }));
    return result;
  } catch (err) {
    console.log(
      JSON.stringify({
        msg: 'job',
        name,
        id,
        durationMs: Date.now() - startedAt,
        ok: false,
        error: (err as Error).message,
      }),
    );
    throw err;
  }
}

export async function stopJobs(): Promise<void> {
  await closeQueue();
}
