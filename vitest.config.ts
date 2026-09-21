import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Every test hits the same Postgres; run files one at a time so they
    // do not truncate each other's rows.
    // The live suite talks to a real provider; it has its own config and script.
    // dashboard/ is a separate app with its own vitest; without this the
    // engine's run would pick up its tests and fail on a missing DOM.
    exclude: ['test/live/**', 'node_modules/**', 'dist/**', 'dashboard/**'],
    fileParallelism: false,
    setupFiles: ['test/setup.ts'],
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
});
