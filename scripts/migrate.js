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
  // two different accounts. Normalize, dedupe, and add the unique index that
  // enforces this going forward.
  //
  // These three steps run on ONE dedicated connection inside BEGIN/COMMIT,
  // not as three separate autocommitted statements. This script is Railway's
  // pre-deploy command, which retries up to 5 times on failure: without a
  // transaction, a failure between the DELETE and the CREATE UNIQUE INDEX
  // would leave the dedupe already applied but the constraint not yet in
  // place, and a retry would re-run the (by-then-idempotent) normalize UPDATE
  // and a no-op DELETE without ever being able to tell "partially applied" from
  // "not applied" apart. Wrapping all of it in one transaction means every
  // retry starts from the same pre-migration state: either everything below
  // lands, or none of it does.
  const dedupeClient = await pool.connect();
  try {
    await dedupeClient.query('BEGIN');

    await dedupeClient.query(`
      UPDATE users SET email = lower(trim(email)) WHERE email <> lower(trim(email));
    `);

    // Recoverable-delete safety net: every row this migration is about to
    // remove is snapshotted here first as jsonb, in case which-row-survived
    // ever needs auditing or manual recovery. A jsonb snapshot rather than
    // `LIKE users`: IF NOT EXISTS can never widen a table that already exists,
    // so a column-for-column clone would break `INSERT ... SELECT u.*` the day
    // users gains a column — only in production, where the table already
    // exists at the old width. Retention: review and drop this table once the
    // dedupe has been confirmed in production; it holds email addresses.
    await dedupeClient.query(`
      CREATE TABLE IF NOT EXISTS users_dedupe_backup (
        id uuid NOT NULL,
        removed_at timestamptz NOT NULL DEFAULT now(),
        row_data jsonb NOT NULL
      );
    `);

    // Decides, for every email with more than one row, which one survives.
    // ON COMMIT DROP: scoped to this migration run, never left behind.
    //
    // The oldest row always wins (created_at ASC, id ASC as the final
    // deterministic tiebreak) — full stop, no exception for which org has a
    // Stripe webhook registered. An earlier version of this migration
    // preferred the webhook-having org, which is backwards: in the exact
    // account-takeover attack this migration follows, the ATTACKER is the one
    // who successfully connected a key and registered a webhook, so that rule
    // would have kept the attacker's row and deleted the victim's original
    // signup. The oldest row has no such failure mode — it is, by
    // construction, the account that existed before any attacker could have
    // raced it.
    //
    // LEFT JOIN organizations, not an inner join: users.org_id currently has
    // NOT NULL + ON DELETE CASCADE, so an inner join would not drop any row
    // today — but this dedupe should not quietly depend on that FK staying
    // exactly as strict as it is now. PARTITION BY lower(email) rather than
    // lower(trim(email)): the normalize UPDATE just above already ran in this
    // same transaction, so email is already trimmed and lowercased here.
    await dedupeClient.query(`
      CREATE TEMP TABLE users_dedupe_losers ON COMMIT DROP AS
      SELECT id, org_id FROM (
        SELECT
          u.id,
          u.org_id,
          row_number() OVER (
            PARTITION BY lower(u.email)
            ORDER BY u.created_at ASC, u.id ASC
          ) AS rn
        FROM users u
        LEFT JOIN organizations o ON o.id = u.org_id
      ) ranked
      WHERE rn > 1;
    `);

    await dedupeClient.query(`
      INSERT INTO users_dedupe_backup (id, row_data)
      SELECT u.id, to_jsonb(u) FROM users u WHERE u.id IN (SELECT id FROM users_dedupe_losers);
    `);

    // A magic link requested just before this deploy still points at the
    // losing org (login_tokens.org_id references organizations, not users), so
    // clicking it after the deploy would land the founder in the org this
    // migration just cut them off from — in the takeover scenario, the
    // attacker's. Void unused tokens for orgs that are about to have no user.
    await dedupeClient.query(`
      DELETE FROM login_tokens
      WHERE used_at IS NULL
        AND org_id IN (SELECT org_id FROM users_dedupe_losers)
        AND org_id NOT IN (
          SELECT org_id FROM users WHERE id NOT IN (SELECT id FROM users_dedupe_losers)
        );
    `);

    const dedupeResult = await dedupeClient.query(`
      DELETE FROM users WHERE id IN (SELECT id FROM users_dedupe_losers)
      RETURNING org_id;
    `);
    if (dedupeResult.rowCount > 0) {
      // Org ids only, never emails — this log reaches Railway's deploy log,
      // and an email address is personal data under POPIA. Org ids identify
      // which accounts to look at without naming anyone.
      const orgIds = [...new Set(dedupeResult.rows.map((row) => row.org_id))];
      console.warn(
        `[migrate] Removed ${dedupeResult.rowCount} duplicate users.email row(s) (backed up in users_dedupe_backup) affecting org(s): ${orgIds.join(', ')}`,
      );
    }

    // Enforces at the database what /api/auth/request now relies on: exactly
    // one account per email. Safe to add now that the dedupe above guarantees
    // no existing row violates it.
    await dedupeClient.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_key ON users (lower(email));
    `);

    await dedupeClient.query('COMMIT');
  } catch (err) {
    await dedupeClient.query('ROLLBACK').catch((rollbackErr) => {
      console.error('[migrate] Rollback of the users dedupe transaction failed:', rollbackErr);
    });
    throw err;
  } finally {
    dedupeClient.release();
  }

  console.log('Database migration complete');
  await pool.end();
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
