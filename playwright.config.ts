import { defineConfig, devices, type PlaywrightTestConfig } from '@playwright/test';
import { E2E_BASE_URL, E2E_CLIENT_IP, E2E_PORT, serverEnv } from './e2e/env';

/**
 * End-to-end suite. See the "End-to-end tests" section of README.md.
 *
 * Serial on purpose (`workers: 1`, `fullyParallel: false`): the specs share one
 * database and the app's rate limiters live in the server process's memory, so
 * parallel workers would both fight over rows and spend each other's login
 * budget.
 */
const reporter: PlaywrightTestConfig['reporter'] = process.env.CI
  ? [['list'], ['html', { open: 'never' }]]
  : 'list';

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter,
  globalSetup: './e2e/global-setup.ts',

  use: {
    baseURL: E2E_BASE_URL,
    trace: 'retain-on-failure',
    // Gives this run its own per-IP rate-limit bucket. See e2e/env.ts.
    extraHTTPHeaders: { 'x-forwarded-for': E2E_CLIENT_IP },
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  webServer: {
    // A production server, not `next dev`: the session cookie is only `secure`
    // (and assertSameOrigin only strict) when NODE_ENV=production. Run
    // `NEXT_PUBLIC_APP_URL=http://localhost:5100 npx next build` first.
    // Started BEFORE globalSetup runs; /api/health does no DB work, so it
    // survives global-setup migrating and truncating the database under it.
    command: `npx next start -p ${E2E_PORT}`,
    url: `${E2E_BASE_URL}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: serverEnv,
  },
});
