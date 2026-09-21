import { serve } from '@hono/node-server';
import { createApp } from './api/app.js';
import { closeDb } from './db/client.js';
import { loadEnv } from './env.js';
import { startJobs, stopJobs } from './jobs/index.js';
import { startTracing, stopTracing } from './otel.js';
import { companyLookup } from './spine/registry/index.js';

// Before anything opens a socket: a service that starts with a missing key and
// finds out on the first send is worse than one that refuses to start.
let config;
try {
  config = loadEnv();
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

await startTracing();
await startJobs();
// Says once whether company enrichment is available, rather than leaving it to
// be discovered on the first upsert that asked for it.
companyLookup();

const server = serve({ fetch: createApp().fetch, port: config.PORT }, (info) => {
  console.log(
    JSON.stringify({ msg: 'listening', port: info.port, version: version(), at: new Date().toISOString() }),
  );
});

export function version(): string {
  return process.env['npm_package_version'] ?? '0.1.0';
}

let shuttingDown = false;

/**
 * Stop accepting new requests, let the ones in flight finish, then let pg-boss
 * finish or requeue whatever it is working on. Anything it does not finish is
 * still on the queue for the next process, so no send is lost.
 */
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(JSON.stringify({ msg: 'shutting down', signal }));

  const forced = setTimeout(() => {
    console.error(JSON.stringify({ msg: 'shutdown timed out, exiting anyway' }));
    process.exit(1);
  }, 30_000);
  forced.unref();

  await new Promise<void>((resolve) => server.close(() => resolve()));
  await stopJobs();
  await stopTracing();
  await closeDb();

  clearTimeout(forced);
  console.log(JSON.stringify({ msg: 'stopped' }));
  process.exit(0);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}
