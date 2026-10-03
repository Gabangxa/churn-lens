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
    // Route suites drive failure paths on purpose, and those now call
    // reportError, which emails ALERT_EMAIL through the real Resend client
    // wherever a suite does not mock it. Pinned empty so a shell that exports
    // ALERT_EMAIL and RESEND_API_KEY (`railway run`, direnv) cannot turn a test
    // run into real alert emails. Suites that test alerting stub it per test.
    env: { ALERT_EMAIL: '' },
  },
  // tsconfig says jsx: "preserve" (Next compiles JSX itself), which leaves
  // esbuild on the classic React.createElement transform — so importing any
  // page or component into a test throws "React is not defined". The automatic
  // runtime is what Next uses, and lets a suite render a page through its
  // public interface (e.g. the survey page in the Stripe webhook's DB suite).
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
});
