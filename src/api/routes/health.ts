import { Hono } from 'hono';
import { db } from '../../db/client.js';
import { queueState } from './webhook-endpoints.js';

export const health = new Hono();

health.get('/health', async (c) => {
  let ok = true;
  try {
    await db()`select 1`;
  } catch (err) {
    console.error('health: db check failed', err);
    ok = false;
  }

  const boss = ok ? await queueState() : 'unknown';
  const version = process.env['npm_package_version'] ?? '0.1.0';

  return c.json({ ok, db: ok, boss, version }, ok ? 200 : 503);
});
