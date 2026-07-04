import { Pool } from 'pg';

// TLS: verify the server certificate when a CA is provided (DATABASE_CA_CERT).
// Without it we fall back to an unverified connection — a MITM risk — so we warn
// loudly rather than doing it silently. Managed Postgres (Supabase/Replit/RDS)
// publishes a CA bundle; set DATABASE_CA_CERT to its PEM contents in prod.
function sslConfig(dbUrl: string): false | { ca: string; rejectUnauthorized: true } | { rejectUnauthorized: false } {
  const isLocalDb = dbUrl.includes('localhost') || dbUrl.includes('127.0.0.1');
  if (isLocalDb) return false;
  if (process.env.DATABASE_SSL === 'disable') return false;

  // Railway's private network is isolated and its internal Postgres listener may
  // not offer TLS, so default to no SSL there. Override with DATABASE_SSL=require.
  const isRailwayInternal = /\.railway\.internal\b/.test(dbUrl);
  if (isRailwayInternal && process.env.DATABASE_SSL !== 'require') return false;

  const ca = process.env.DATABASE_CA_CERT;
  if (ca) return { ca, rejectUnauthorized: true };
  console.warn(
    '[db] DATABASE_CA_CERT not set — DB TLS certificate verification is DISABLED (MITM risk). Set DATABASE_CA_CERT to enable it.',
  );
  return { rejectUnauthorized: false };
}

// Lazy singleton. The pool (and the DATABASE_URL requirement) is created on the
// first query, not at import time. Next.js imports server route modules during
// the build's "Collecting page data" step, so a module-scope throw or connect
// here would fail the build before the runtime secret is available.
let pool: Pool | null = null;

function getPool(): Pool {
  if (pool) return pool;
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    throw new Error('DATABASE_URL is not set.');
  }
  pool = new Pool({
    connectionString: dbUrl,
    ssl: sslConfig(dbUrl),
  });
  pool.on('error', (err) => {
    console.error('Unexpected PostgreSQL pool error:', err);
  });
  return pool;
}

export async function query<T = Record<string, unknown>>(
  text: string,
  params?: unknown[],
): Promise<T[]> {
  const result = await getPool().query(text, params);
  return result.rows as T[];
}

export async function execute(
  text: string,
  params?: unknown[],
): Promise<number> {
  const result = await getPool().query(text, params);
  return result.rowCount ?? 0;
}

export async function queryOne<T = Record<string, unknown>>(
  text: string,
  params?: unknown[],
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

export async function queryCount(
  text: string,
  params?: unknown[],
): Promise<number> {
  const result = await getPool().query(text, params);
  return parseInt(result.rows[0]?.count ?? '0', 10);
}

export interface Organization {
  id: string;
  name: string;
  stripe_account_id: string | null;
  stripe_api_key_enc: string | null;
  stripe_webhook_id: string | null;
  stripe_webhook_secret_enc: string | null;
  resend_verified: boolean;
  plan: 'free' | 'starter' | 'growth';
  created_at: string;
}

export interface SurveyResponse {
  id: string;
  org_id: string;
  customer_email: string;
  customer_name: string | null;
  stripe_subscription_id: string;
  mrr_lost: number;
  reason_category: string | null;
  open_text: string | null;
  comeback_text: string | null;
  theme_tags: string[];
  surveyed_at: string | null;
}

export interface Theme {
  id: string;
  org_id: string;
  week_of: string;
  label: string;
  response_count: number;
  representative_quotes: string[];
  mrr_impact: number;
  created_at: string;
}
