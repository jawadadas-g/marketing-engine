import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Every test hits the same Postgres; run files one at a time so they
    // do not truncate each other's rows.
    fileParallelism: false,
    setupFiles: ['test/setup.ts'],
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
});
