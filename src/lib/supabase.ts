import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

// Browser-safe client (uses anon key)
export const supabase = createClient(supabaseUrl, supabaseAnonKey);

// Server-only admin client (bypasses RLS — never expose to browser)
export function getAdminClient() {
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY not set');
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// --- Type definitions mirroring the DB schema ---

export interface Organization {
  id: string;
  name: string;
  stripe_account_id: string | null;
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
  reason_category: string;
  open_text: string | null;
  comeback_text: string | null;
  theme_tags: string[];
  surveyed_at: string;
}

export interface Theme {
  id: string;
  org_id: string;
  week_of: string;         // ISO date — Monday of the week
  label: string;
  response_count: number;
  representative_quotes: string[];
  mrr_impact: number;
  created_at: string;
}
