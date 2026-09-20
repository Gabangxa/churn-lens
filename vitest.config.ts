import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    // Agent scratch worktrees live under .claude/; their suites are not ours.
    // e2e/ holds Playwright specs — same `test`/`expect` names, a completely
    // different runner. Vitest picking them up fails at import, not at assert.
    exclude: ['**/node_modules/**', '**/.claude/**', 'e2e/**'],
    // The *.db.test.ts suites each TRUNCATE the shared TEST_DATABASE_URL
    // between tests; run in parallel they wipe each other's fixtures mid-test.
    // Serialise files only when that database is in play so the default
    // (mocked) run keeps its parallelism.
    fileParallelism: !process.env.TEST_DATABASE_URL,
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
});
