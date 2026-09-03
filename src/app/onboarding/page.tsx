import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getOrgIdFromCookieStore } from '@/lib/auth';
import OnboardingForm from './OnboardingForm';

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
  searchParams: { plan?: string };
}) {
  const orgId = getOrgIdFromCookieStore(cookies());
  if (!orgId) {
    const plan = searchParams.plan;
    redirect('/login?next=/onboarding' + (plan ? '&plan=' + plan : ''));
  }

  return <OnboardingForm />;
}
