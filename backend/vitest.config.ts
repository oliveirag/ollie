import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Integration tests share one Postgres database; running files in parallel
    // would interleave their writes to the single-row app_settings table.
    fileParallelism: false,
    testTimeout: 20_000,
    setupFiles: ['test/setup.ts'],
  },
});
