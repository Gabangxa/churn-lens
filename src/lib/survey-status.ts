import { queryCount } from '@/lib/db';
import { FREE_TIER_MONTHLY_SURVEYS, freeTierWindowStart } from '@/lib/plan';

/**
 * Whether a cancellation arriving now would actually be surveyed, as the
 * founder should see it.
 *
 * The Stripe webhook (src/app/api/webhooks/stripe/[orgId]/route.ts) skips
 * events with a 200 for each of these reasons, and nothing else reported
 * them — the dashboard said "surveys firing automatically" while every event
 * was being dropped. This mirrors those gates so the two cannot disagree.
 *
 * Only org-wide gates are states here. Skips decided by the individual
 * cancellation (involuntary churn, an opted-out or email-less customer, a
 * duplicate delivery) say nothing about whether the *next* one will be
 * surveyed; the dashboard's 'sending' line names involuntary churn in its copy
 * instead, because that is a whole class of cancellations rather than a rare one.
 */
export type SurveySendStatus =
  | { kind: 'sending' }
  | { kind: 'stripe_not_connected' }
  | { kind: 'deletion_pending' }
  | { kind: 'paused_by_churnlens' }
  | { kind: 'free_tier_limit'; limit: number; resetsOn: Date };

export function surveySendStatus(input: {
  stripeConnected: boolean;
  deletionRequested: boolean;
  /** legalFooterReady() from src/lib/legal — injected so this stays pure. */
  legalFooterReady: boolean;
  plan: string;
  surveysThisMonth: number;
  now?: Date;
}): SurveySendStatus {
  if (!input.stripeConnected) return { kind: 'stripe_not_connected' };
  if (input.deletionRequested) return { kind: 'deletion_pending' };
  if (!input.legalFooterReady) return { kind: 'paused_by_churnlens' };
  if (input.plan === 'free' && input.surveysThisMonth >= FREE_TIER_MONTHLY_SURVEYS) {
    const start = freeTierWindowStart(input.now);
    return {
      kind: 'free_tier_limit',
      limit: FREE_TIER_MONTHLY_SURVEYS,
      resetsOn: new Date(start.getFullYear(), start.getMonth() + 1, 1),
    };
  }
  return { kind: 'sending' };
}

/**
 * Surveys counted against the free-tier cap this month. Counted by created_at
 * (surveys sent), not surveyed_at (responses): most customers never respond,
 * so counting responses would let a free org send without limit.
 */
export function countFreeTierSurveys(orgId: string, now: Date = new Date()): Promise<number> {
  return queryCount(
    'SELECT COUNT(*) FROM survey_responses WHERE org_id = $1 AND created_at >= $2 AND NOT is_test',
    [orgId, freeTierWindowStart(now).toISOString()],
  );
}
