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
process.env.SUPABASE_JWT_SECRET ??= 'test-secret';
