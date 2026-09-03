const { Pool } = require('pg');

const dbUrl = process.env.DATABASE_URL ?? '';
const isLocalDb = dbUrl.includes('localhost') || dbUrl.includes('127.0.0.1');

// TLS: verify the server certificate when a CA is provided (DATABASE_CA_CERT).
// Falling back to an unverified connection is a MITM risk, so we warn loudly
// rather than doing it silently. See src/lib/db.ts for the request-path copy.
function sslConfig() {
  if (isLocalDb) return false;
  if (process.env.DATABASE_SSL === 'disable') return false;

  // Railway's private network is isolated and its internal Postgres listener may
  // not offer TLS, so default to no SSL there. Override with DATABASE_SSL=require.
  const isRailwayInternal = /\.railway\.internal\b/.test(dbUrl);
  if (isRailwayInternal && process.env.DATABASE_SSL !== 'require') return false;

  const ca = process.env.DATABASE_CA_CERT;
  if (ca) return { ca, rejectUnauthorized: true };
  console.warn(
    '[migrate] DATABASE_CA_CERT not set — DB TLS certificate verification is DISABLED (MITM risk). Set DATABASE_CA_CERT to enable it.',
  );
  return { rejectUnauthorized: false };
}

const pool = new Pool({
  connectionString: dbUrl || undefined,
  ssl: sslConfig(),
});

async function migrate() {
  await pool.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS organizations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      stripe_account_id text UNIQUE,
      stripe_api_key_enc text,
      resend_verified boolean NOT NULL DEFAULT false,
      plan text NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'starter', 'growth')),
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
      email text NOT NULL,
      name text,
      password_hash text,
      role text NOT NULL DEFAULT 'owner' CHECK (role IN ('owner', 'member')),
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS survey_responses (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
      customer_email text NOT NULL,
      customer_name text,
      stripe_subscription_id text NOT NULL,
      mrr_lost integer NOT NULL DEFAULT 0,
      token text UNIQUE,
      reason_category text,
      open_text text,
      comeback_text text,
      theme_tags text[] NOT NULL DEFAULT '{}',
      surveyed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS survey_responses_org_week ON survey_responses (org_id, surveyed_at DESC);

    CREATE TABLE IF NOT EXISTS themes (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
      week_of date NOT NULL,
      label text NOT NULL,
      response_count integer NOT NULL DEFAULT 0,
      representative_quotes text[] NOT NULL DEFAULT '{}',
      mrr_impact integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (org_id, week_of, label)
    );

    CREATE INDEX IF NOT EXISTS themes_org_week ON themes (org_id, week_of DESC);
  `);

  // Additive migrations — safe to run on an existing schema.
  // ADD COLUMN supports IF NOT EXISTS; ADD CONSTRAINT does NOT (any PG version),
  // so the unique constraint is guarded via a catalog check in a DO block.
  await pool.query(`
    ALTER TABLE organizations
      ADD COLUMN IF NOT EXISTS stripe_webhook_id text,
      ADD COLUMN IF NOT EXISTS stripe_webhook_secret_enc text;
  `);

  // Light survey customization (CL-1): per-org display name / logo URL /
  // extra cancellation reasons. Nullable, no default — NULL means zero-config
  // (today's behavior). See src/lib/survey-config.ts for shape + validation.
  await pool.query(`
    ALTER TABLE organizations
      ADD COLUMN IF NOT EXISTS survey_config jsonb;
  `);

  // Test surveys (sent from Settings) are flagged so they never pollute stats,
  // themes, digests, or the free-tier cap.
  await pool.query(`
    ALTER TABLE survey_responses
      ADD COLUMN IF NOT EXISTS is_test boolean NOT NULL DEFAULT false;
  `);

  // Survey email delivery bookkeeping. Without these, a failed Resend send left
  // a row with surveyed_at NULL — indistinguishable from a customer who simply
  // never replied — while Stripe's webhook retry hit the ON CONFLICT DO NOTHING
  // idempotency guard and reported a duplicate, so the email was lost forever.
  // survey_email_sent_at NULL means "no email has ever successfully gone out",
  // which is what makes a stranded row re-sendable; survey_email_attempts caps
  // how long we keep asking Stripe to retry a permanently-failing address.
  //
  // survey_email_last_attempt_at is the concurrency guard. Stripe delivers
  // at-least-once, so two deliveries of the same event can be in flight at the
  // same time; both would otherwise see survey_email_sent_at NULL (it is only
  // stamped AFTER the send returns) and both would email the customer. The
  // webhook claims a send with a conditional UPDATE on this column, so the
  // second delivery finds a fresh timestamp and backs off. A stranded row is
  // still re-sendable once the timestamp ages past the cooldown.
  await pool.query(`
    ALTER TABLE survey_responses
      ADD COLUMN IF NOT EXISTS survey_email_sent_at timestamptz,
      ADD COLUMN IF NOT EXISTS survey_email_attempts integer NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS survey_email_last_attempt_at timestamptz;
  `);

  // Polar billing linkage. ChurnLens bills itself through Polar (its customers'
  // Stripe keys are a separate, unrelated thing — see stripe_api_key_enc).
  //
  // polar_synced_at holds the `modified_at` of the last subscription event we
  // applied. Webhook delivery is not ordered, so a delayed `subscription.updated`
  // can arrive after the `subscription.revoked` that superseded it; without a
  // watermark that stale event would silently restore a plan the customer no
  // longer pays for. Events at or before this timestamp are ignored.
  await pool.query(`
    ALTER TABLE organizations
      ADD COLUMN IF NOT EXISTS polar_customer_id text,
      ADD COLUMN IF NOT EXISTS polar_subscription_id text,
      ADD COLUMN IF NOT EXISTS polar_synced_at timestamptz;
  `);

  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'survey_responses_stripe_subscription_id_key'
      ) THEN
        ALTER TABLE survey_responses
          ADD CONSTRAINT survey_responses_stripe_subscription_id_key
          UNIQUE (stripe_subscription_id);
      END IF;
    END $$;
  `);

  // At-most-once-per-week guard for the weekly cron jobs. A successful claim is
  // an INSERT that wins the ON CONFLICT race; duplicate fires (process restart,
  // extra instance, manual retry) become no-ops. See src/app/api/{themes,digest}.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cron_runs (
      job text NOT NULL,
      week_of date NOT NULL,
      ran_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (job, week_of)
    );
  `);

  // Exit-survey opt-outs (CAN-SPAM). One row per (org, customer email) suppresses
  // future survey emails for that customer.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS unsubscribes (
      org_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
      customer_email text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (org_id, customer_email)
    );
  `);

  // Passwordless magic-link login. We store only the SHA-256 hash of the token
  // (the raw token lives only in the emailed link), single-use via used_at, with
  // a short expiry. See src/app/api/auth/{request,verify}.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS login_tokens (
      token_hash text PRIMARY KEY,
      org_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
      email text NOT NULL,
      expires_at timestamptz NOT NULL,
      used_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS login_tokens_email ON login_tokens (email);
  `);

  // Post-login destination for a magic link (e.g. "/onboarding?plan=starter"
  // so a pricing-page click survives the signup/login round trip). Nullable:
  // NULL means "decide at verify time" (dashboard, or onboarding if the org
  // has no Stripe key yet). See src/app/api/auth/{request,verify}.
  await pool.query(`
    ALTER TABLE login_tokens ADD COLUMN IF NOT EXISTS redirect_to text;
  `);

  // From here on, /api/auth/request treats "a users row exists for lower(email)"
  // as the account, and creates one for any email it has never seen — so two
  // rows that differ only by case or stray whitespace would silently become
  // two different accounts. Normalize what's already stored before the unique
  // index below can enforce it going forward.
  await pool.query(`
    UPDATE users SET email = lower(trim(email)) WHERE email <> lower(trim(email));
  `);

  // Dedupe users by (lower) email before the unique index can be added, so an
  // org already carrying two rows for the same address (the account-takeover
  // bug this migration accompanies fixed the code path, but not existing data)
  // doesn't fail the CREATE UNIQUE INDEX below.
  //
  // Keeps exactly one row per email: the row whose org has already registered
  // a Stripe webhook (stripe_webhook_id IS NOT NULL) wins, tie-broken by the
  // newest such row — that's the org actually in use. If no row for that email
  // has a connected org, the oldest row wins instead, on the assumption that
  // it's the original signup and everything newer is noise (including, in the
  // specific attack this migration follows, an attacker's org — which SHOULD
  // have a webhook if they got that far, but if not, "oldest" still favors the
  // victim's real account over a fresher hostile one). A single CTE-driven
  // DELETE keeps the decision atomic and deterministic; it is a no-op (deletes
  // nothing) when every email already maps to one row.
  const dedupeResult = await pool.query(`
    WITH ranked AS (
      SELECT
        u.id,
        u.email,
        row_number() OVER (
          PARTITION BY lower(trim(u.email))
          ORDER BY
            (o.stripe_webhook_id IS NOT NULL) DESC,
            CASE WHEN o.stripe_webhook_id IS NOT NULL THEN u.created_at END DESC NULLS LAST,
            u.created_at ASC,
            u.id ASC
        ) AS rn
      FROM users u
      JOIN organizations o ON o.id = u.org_id
    ),
    losers AS (
      SELECT id, email FROM ranked WHERE rn > 1
    )
    DELETE FROM users WHERE id IN (SELECT id FROM losers)
    RETURNING email;
  `);
  if (dedupeResult.rowCount > 0) {
    const counts = new Map();
    for (const row of dedupeResult.rows) {
      counts.set(row.email, (counts.get(row.email) ?? 0) + 1);
    }
    const summary = [...counts.entries()].map(([email, n]) => `${email} (${n})`).join(', ');
    console.warn(
      `[migrate] Removed ${dedupeResult.rowCount} duplicate users.email row(s) before adding the unique index: ${summary}`,
    );
  }

  // Enforces at the database what /api/auth/request now relies on: exactly one
  // account per email. Safe to add now that the dedupe above guarantees no
  // existing row violates it.
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_key ON users (lower(email));
  `);

  console.log('Database migration complete');
  await pool.end();
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
