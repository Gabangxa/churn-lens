import Stripe from 'stripe';
import { execute } from '@/lib/db';
import { normalizeBusinessName } from '@/lib/survey-config';
import { reportError } from '@/lib/report-error';

// The lookup is garnish on a request whose job is something else (sending the
// survey, saving a key). Bounded well under Stripe's webhook timeout and not
// retried: the SDK's defaults (80s, one retry) could otherwise hold a survey
// send hostage to an optional name.
const ACCOUNT_LOOKUP_TIMEOUT_MS = 5_000;

/**
 * Best-effort lookup of the connected Stripe account's public business name,
 * so a survey can say which business is asking (POPIA s18) when the founder
 * has set no display name. See SurveyPresentation.businessName.
 *
 * Reading the account (GET /v1/account) needs a restricted-key permission
 * that onboarding does NOT ask for — it asks for customers:read,
 * subscriptions:read and webhooks:write only, and adding a requirement would
 * break every org already connected. So for most keys this answers 403, and
 * that is a normal outcome, not a fault: the caller falls back to the generic
 * copy. For the same reason no failure here — 401 and 403 included — says
 * anything about whether surveys can be sent, and none of them may mark the
 * key invalid (only the webhook's customer lookup does that).
 *
 * Never throws. Returns null on any failure or when the account has no usable
 * name, after logging the org id (never the key) for the failures.
 */
export async function fetchStripeBusinessName(
  stripeClient: Stripe,
  orgId: string,
): Promise<string | null> {
  try {
    const account = await stripeClient.accounts.retrieveCurrent(
      {},
      { timeout: ACCOUNT_LOOKUP_TIMEOUT_MS, maxNetworkRetries: 0 },
    );
    return (
      normalizeBusinessName(account.business_profile?.name) ??
      normalizeBusinessName(account.settings?.dashboard?.display_name)
    );
  } catch (err) {
    if (err instanceof Stripe.errors.StripePermissionError) {
      console.warn(
        `Stripe key for org ${orgId} may not read the account, so surveys cannot name the business ` +
          'from Stripe — they use the configured display name, or the generic copy.',
      );
    } else {
      console.warn(`Stripe account name lookup failed for org ${orgId}; using the fallback copy:`, err);
    }
    return null;
  }
}

/**
 * Caches a name fetchStripeBusinessName found, for the survey page (which
 * never calls Stripe) and later sends. Returns whether it was stored, so a
 * caller that must name the same business everywhere can use the name only
 * once the page will see it too. Never throws.
 */
export async function cacheStripeBusinessName(orgId: string, name: string): Promise<boolean> {
  try {
    await execute('UPDATE organizations SET stripe_business_name = $1 WHERE id = $2', [name, orgId]);
    return true;
  } catch (err) {
    // A database write failing, not Stripe saying no (fetchStripeBusinessName
    // owns those, as warnings): the caller falls back to the generic copy.
    reportError('stripe.business-name', err, { orgId, step: 'cache' });
    return false;
  }
}
