import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getOrgIdFromCookieStore } from '@/lib/auth';
import OnboardingForm from './OnboardingForm';

const ALLOWED_PLANS = new Set(['starter', 'growth']);

/**
 * Server-side session gate. Onboarding used to be reachable with no session
 * at all — it created the org and user itself, which is the account-takeover
 * hole this page's sibling API route was rewritten to close. Now a session is
 * a precondition, minted only by /api/auth/verify, so an unauthenticated
 * visitor is sent to log in (or sign up) first, carrying `plan` along so it
 * survives the round trip and lands them back here.
 */
export default function OnboardingPage({
  searchParams,
}: {
  searchParams: { plan?: string | string[] };
}) {
  const orgId = getOrgIdFromCookieStore(cookies());
  if (!orgId) {
    // Next.js parses a repeated query param (?plan=a&plan=b) as string[], not
    // string — take the first value if so, rather than crashing on `plan ?
    // '&plan=' + plan` producing "&plan=a,b" (Array#toString joins with a
    // comma, which is not on /login's or /api/auth/request's allow-list and
    // would just get silently dropped further down the chain, but is still
    // worth not constructing in the first place). Then allow-list it the same
    // way /api/auth/request does: only 'starter' and 'growth' are real plans,
    // anything else (typo, probing, an old/removed tier) is dropped rather
    // than carried forward unchecked.
    const rawPlan = Array.isArray(searchParams.plan) ? searchParams.plan[0] : searchParams.plan;
    const plan = rawPlan && ALLOWED_PLANS.has(rawPlan) ? rawPlan : null;
    redirect('/login?next=/onboarding' + (plan ? '&plan=' + plan : ''));
  }

  return <OnboardingForm />;
}
