/**
 * The one definition of the end-to-end environment.
 *
 * Imported by playwright.config.ts (which passes `serverEnv` to the Next
 * server it boots), by e2e/global-setup.ts (which migrates and truncates the
 * test database) and by the helpers under e2e/helpers. Defining it once is
 * what stops the server, the seeder and the assertions from drifting onto
 * three different databases or three different cron secrets.
 *
 * Every secret here is fake on purpose. RESEND_API_KEY in particular is
 * deliberately invalid: /api/auth/request logs the failed send and still
 * answers { ok: true }, which is exactly the behaviour the suite asserts, and
 * it guarantees no test run can email a real inbox.
 */

/**
 * Re-exported so callers that already import the E2E environment get the
 * guard with it. The implementation lives in helpers/throwaway-db.ts because
 * the DB-gated vitest suite imports it too, and must not pull Playwright in.
 */
export { assertThrowawayDatabase } from './helpers/throwaway-db';

/** Throwaway Postgres. `bash scripts/e2e-db.sh up` starts one at this URL. */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:pw@127.0.0.1:55432/churnlens_test';

// 5100, not 5000: `npm run dev` uses 5000, and `reuseExistingServer` would
// happily adopt a running dev server — pointing the suite (which truncates
// everything it touches) at a developer's real .env database and live Resend
// key. A separate port makes that impossible rather than merely unlikely.
export const E2E_PORT = 5100;
export const E2E_BASE_URL = `http://localhost:${E2E_PORT}`;

/** Gates /api/themes, /api/digest and /api/purge. */
export const E2E_CRON_SECRET = 'e2e-cron-secret-not-a-real-one';

/** Fixed 64 hex chars (32 bytes) — validateEnv() rejects anything else. */
export const E2E_ENCRYPTION_KEY =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

/**
 * Every request the suite makes carries this as `x-forwarded-for`, and
 * `clientIp()` (src/lib/ratelimit.ts) reads the LAST hop of that header — so
 * each run lands in its own per-IP rate-limit bucket.
 *
 * That matters because the rate limiters are in-process and only reset when
 * the server restarts, while `reuseExistingServer` deliberately keeps one
 * server across repeated local runs. Without this, the fifth `npm run e2e`
 * against the same server would start failing the one real login submission
 * on a 429 rather than on anything about the app. Randomized per process
 * rather than fixed, so nothing accumulates across runs.
 */
export const E2E_CLIENT_IP = `10.${randomOctet()}.${randomOctet()}.${randomOctet()}`;

function randomOctet(): number {
  return Math.floor(Math.random() * 254) + 1;
}

/**
 * Environment for the `next start` server under test. NODE_ENV=production is
 * load-bearing: it makes the session cookie `secure` (Chromium accepts that
 * over http://localhost) and switches assertSameOrigin to allow-listing only
 * NEXT_PUBLIC_APP_URL, which is what the CSRF specs exercise.
 */
export const serverEnv: Record<string, string> = {
  DATABASE_URL: TEST_DATABASE_URL,
  ENCRYPTION_KEY: E2E_ENCRYPTION_KEY,
  RESEND_API_KEY: 're_e2e_fake_key_sends_always_fail',
  CRON_SECRET: E2E_CRON_SECRET,
  NEXT_PUBLIC_APP_URL: E2E_BASE_URL,
  OPENAI_API_KEY: 'sk-e2e-fake-key',
  NODE_ENV: 'production',
  // The in-process scheduler (src/instrumentation.ts) fires themes, digest and
  // purge ~30s after boot and every 10 minutes after that. On a reused server
  // that lands in the middle of a run and either steals a cron claim the cron
  // spec is about to make or deletes rows it just seeded. Env validation still
  // runs; only the poll loop is off.
  E2E_DISABLE_SCHEDULER: '1',
};
