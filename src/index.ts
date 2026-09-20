import { serve } from '@hono/node-server';
import { createApp } from './api/app.js';
import { closeDb } from './db/client.js';
import { startJobs, stopJobs } from './jobs/index.js';

const port = Number(process.env.PORT ?? 3000);

await startJobs();

const server = serve({ fetch: createApp().fetch, port }, (info) => {
  console.log(`marketing-engine listening on :${info.port}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`${signal}: shutting down`);
    server.close(async () => {
      await stopJobs();
      await closeDb();
      process.exit(0);
    });
  });
}
