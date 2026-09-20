import { defineConfig } from 'vitest/config';

// The live suite is separate so `npm test` never reaches a real provider.
export default defineConfig({
  test: {
    include: ['test/live/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    fileParallelism: false,
    hookTimeout: 60_000,
    testTimeout: 60_000,
  },
});
