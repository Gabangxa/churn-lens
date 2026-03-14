import { Pool } from 'pg';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set — database queries will fail.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: false,
});

pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL pool error:', err);
});

export { pool };

export async function query<T = Record<string, unknown>>(
  text: string,
  params?: unknown[],
): Promise<T[]> {
  const result = await pool.query(text, params);
  return result.rows as T[];
}

export async function execute(
  text: string,
  params?: unknown[],
): Promise<number> {
  const result = await pool.query(text, params);
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
  const result = await pool.query(text, params);
  return parseInt(result.rows[0]?.count ?? '0', 10);
}

export interface Organization {
  id: string;
  name: string;
  stripe_account_id: string | null;
  stripe_api_key_enc: string | null;
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
