const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: false,
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
  console.log('Database migration complete');
  await pool.end();
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
