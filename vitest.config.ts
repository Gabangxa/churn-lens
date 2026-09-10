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
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
});
