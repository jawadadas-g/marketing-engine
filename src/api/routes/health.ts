import { Hono } from 'hono';
import { db } from '../../db/client.js';

export const health = new Hono();

health.get('/health', async (c) => {
  let ok = true;
  try {
    await db()`select 1`;
  } catch (err) {
    console.error('health: db check failed', err);
    ok = false;
  }
  return c.json({ ok, db: ok }, ok ? 200 : 503);
});
