const { Pool } = require('pg');

const dbUrl = process.env.DATABASE_URL ?? '';
const isLocalDb = dbUrl.includes('localhost') || dbUrl.includes('127.0.0.1');

// TLS: verify the server certificate when a CA is provided (DATABASE_CA_CERT).
// Falling back to an unverified connection is a MITM risk, so we warn loudly
// rather than doing it silently. See src/lib/db.ts for the request-path copy.
function sslConfig() {
  if (isLocalDb) return false;
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

  console.log('Database migration complete');
  await pool.end();
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
