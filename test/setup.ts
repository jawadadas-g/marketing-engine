// Point the client at the test database before anything opens a pool.
try {
  process.loadEnvFile('.env');
} catch {
  // no .env locally or in CI; rely on exported variables
}

const testUrl = process.env.DATABASE_URL_TEST;
if (!testUrl) {
  throw new Error('DATABASE_URL_TEST is not set — tests run against a real Postgres');
}
process.env.DATABASE_URL = testUrl;
process.env.JWT_SECRET ??= 'test-secret';
process.env.CREDENTIALS_KEY ??=
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.WEBHOOK_TOKEN ??= 'test-webhook-token';
// Set, not defaulted: the tests stand up loopback listeners over http, and the
// webhook URL check only allows http when the engine itself is running on it.
// This mirrors local development, where PUBLIC_BASE_URL is an http localhost.
process.env.PUBLIC_BASE_URL = 'http://engine.test';
process.env.INTERNAL_TOKEN ??= 'test-internal-token';
process.env.MARKETPLACE_SIGNUP_URL ??= 'https://marketplace.test/signup';
process.env.LEDGER ??= 'internal';
process.env.FINDER ??= 'basic';
