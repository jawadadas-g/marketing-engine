import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { auth, type AuthVars } from './middleware/auth.js';
import { idempotency } from './middleware/idempotency.js';
import { consent } from './routes/consent.js';
import { events } from './routes/events.js';
import { health } from './routes/health.js';
import { rules } from './routes/rules.js';
import { InvalidAddressError } from '../spine/contacts/normalize.js';

export function createApp() {
  const app = new Hono<AuthVars>();

  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    if (err instanceof InvalidAddressError) return c.json({ error: err.message }, 400);
    console.error('unhandled error', err);
    return c.json({ error: 'internal error' }, 500);
  });

  app.route('/', health);

  app.use('/v1/*', auth);
  app.use('/v1/*', idempotency);
  app.route('/', events);
  app.route('/', consent);
  app.route('/', rules);

  return app;
}
