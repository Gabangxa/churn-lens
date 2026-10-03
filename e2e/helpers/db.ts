import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { TEST_DATABASE_URL } from '../env';

/**
 * Direct database access for the e2e specs: seed the preconditions a flow
 * needs, then assert what the flow actually wrote.
 *
 * Deliberately decoupled from src/: nothing here imports the app's own db or
 * crypto module. A test that seeds rows with the same helper the app uses to
 * write them can pass while both are wrong in the same way; raw SQL and a
 * locally computed token hash keep the assertions independent of the code
 * under test.
 */

let pool: Pool | null = null;

function getPool(): Pool {
  if (!pool) {
    pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 4 });
  }
  return pool;
}

export async function query<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = await getPool().query(text, params);
  return result.rows as T[];
}

export async function queryOne<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

/** Call from a spec's test.afterAll — an open pool keeps the worker alive. */
export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

let emailCounter = 0;

/**
 * A never-before-used address. Unique per call AND per run: the login route
 * rate-limits 5 requests per 15 minutes per email, and its in-memory buckets
 * outlive a test run whenever the server is reused (see e2e/env.ts).
 */
export function uniqueEmail(prefix: string): string {
  emailCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${emailCounter}-${randomBytes(3).toString('hex')}@e2e.test`;
}

/** A timestamp `days` in the past, for retention/abandonment windows. */
export function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

export interface SeedOrgOptions {
  /** Owner user's email. Use uniqueEmail() unless the test needs a literal. */
  email: string;
  name?: string;
  /**
   * Store a Stripe key. The value is an opaque non-null string, NOT real
   * ciphertext: nothing in the flows under test decrypts it (only
   * disconnectStripe does, and only when stripe_webhook_id is also set — see
   * withStripeWebhook). Everything else — /api/settings/status, the
   * dashboard's status line, the purge job's abandoned-signup rule — tests the
   * column for NULL. Keeping it opaque also means no test can accidentally
   * reach Stripe.
   *
   * On its own this is a HALF-connected org (connect saved the key, then
   * failed to register the webhook), which sign-in sends to /onboarding
   * whatever redirect_to says. Add withStripeWebhook for a connected org.
   */
  withStripeKey?: boolean;
  /**
   * Also record a registered webhook (opaque id), completing the connection:
   * sign-in then honours redirect_to and defaults to /dashboard. Requires
   * withStripeKey. Do not use it in a flow that disconnects Stripe (account
   * deletion, Settings disconnect): disconnectStripe would try to decrypt the
   * placeholder key to delete the endpoint, fail, and report an error.
   */
  withStripeWebhook?: boolean;
  createdAt?: Date;
  deletionRequestedAt?: Date;
  lastLoginAt?: Date;
}

export async function seedOrg(options: SeedOrgOptions): Promise<{ orgId: string }> {
  if (options.withStripeWebhook && !options.withStripeKey) {
    // No real org is in that state: connect stores the key before it registers the webhook.
    throw new Error('seedOrg: withStripeWebhook requires withStripeKey');
  }
  const orgId = randomUUID();
  await query(
    `INSERT INTO organizations
       (id, name, created_at, last_login_at, deletion_requested_at, stripe_api_key_enc, stripe_webhook_id)
     VALUES ($1, $2, COALESCE($3::timestamptz, now()), $4, $5, $6, $7)`,
    [
      orgId,
      options.name ?? 'E2E Organization',
      options.createdAt ?? null,
      options.lastLoginAt ?? null,
      options.deletionRequestedAt ?? null,
      options.withStripeKey ? 'e2e-placeholder-not-real-ciphertext' : null,
      options.withStripeWebhook ? 'we_e2e_placeholder_not_registered' : null,
    ],
  );
  await query(
    `INSERT INTO users (org_id, email, role) VALUES ($1, $2, 'owner')`,
    [orgId, options.email.trim().toLowerCase()],
  );
  return { orgId };
}

/**
 * Mirrors src/lib/crypto.ts hashLoginToken: sha256 of the raw token, hex.
 * Recomputed here rather than imported so the specs prove the stored format,
 * not merely that two callers of the same function agree.
 */
function hashLoginToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface SeedLoginTokenOptions {
  /** Written to login_tokens.redirect_to. /api/auth/verify re-validates it. */
  redirectTo?: string | null;
  /** Default 15 minutes, matching the real TTL. Negative = already expired. */
  expiresInMs?: number;
}

/**
 * Write a magic-link token the way /api/auth/request does (hash only) and
 * return the raw token plus the path of the link the email would carry.
 *
 * A path, not an absolute URL, so it resolves against the run's configured
 * baseURL in page.goto — the same server everything else in the run talks to.
 * Opening it lands on the /login/confirm page; nothing is signed in until
 * that page's "Sign in" is pressed (see confirmSignIn in ./session).
 */
export async function seedLoginToken(
  orgId: string,
  email: string,
  options: SeedLoginTokenOptions = {},
): Promise<{ rawToken: string; verifyPath: string }> {
  // 32 random bytes, base64url — the shape generateLoginToken() emits.
  const rawToken = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + (options.expiresInMs ?? 15 * 60 * 1000));
  await query(
    `INSERT INTO login_tokens (token_hash, org_id, email, expires_at, redirect_to)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      hashLoginToken(rawToken),
      orgId,
      email.trim().toLowerCase(),
      expiresAt.toISOString(),
      options.redirectTo ?? null,
    ],
  );
  return {
    rawToken,
    verifyPath: `/api/auth/verify?token=${encodeURIComponent(rawToken)}`,
  };
}

/** login_tokens.used_at for a raw token (null while unspent); throws if no such token was seeded. */
export async function loginTokenUsedAt(rawToken: string): Promise<string | null> {
  const row = await queryOne<{ used_at: string | null }>(
    'SELECT used_at FROM login_tokens WHERE token_hash = $1',
    [hashLoginToken(rawToken)],
  );
  if (!row) throw new Error('no login_tokens row for that token');
  return row.used_at;
}

export interface SeedSurveyResponseOptions {
  customerEmail: string;
  /** Drives the purge job's 24-month retention window. */
  createdAt: Date;
}

export async function seedSurveyResponse(
  orgId: string,
  options: SeedSurveyResponseOptions,
): Promise<{ responseId: string }> {
  const responseId = randomUUID();
  await query(
    `INSERT INTO survey_responses
       (id, org_id, customer_email, stripe_subscription_id, created_at)
     VALUES ($1, $2, $3, $4, $5)`,
    // stripe_subscription_id carries a UNIQUE constraint, so it is generated.
    [responseId, orgId, options.customerEmail, `sub_e2e_${randomBytes(8).toString('hex')}`, options.createdAt.toISOString()],
  );
  return { responseId };
}

export async function seedUnsubscribe(orgId: string, customerEmail: string): Promise<void> {
  await query(
    `INSERT INTO unsubscribes (org_id, customer_email) VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [orgId, customerEmail],
  );
}

/**
 * Drop a job's cron_runs rows so the next call actually does the work instead
 * of answering `already_ran`. The in-process scheduler (src/instrumentation.ts)
 * may well have run every job within 30s of the server booting.
 */
export async function resetCronRun(job: string): Promise<void> {
  await query('DELETE FROM cron_runs WHERE job = $1', [job]);
}
