import { NextRequest, NextResponse } from 'next/server';
import { PolarError } from '@polar-sh/sdk/models/errors/polarerror.js';
import { HTTPValidationError } from '@polar-sh/sdk/models/errors/httpvalidationerror.js';
import { requireOrgId } from '@/lib/auth';
import { publicAppUrl, redirectUrl } from '@/lib/app-url';
import { getPolar, isPolarConfigured } from '@/lib/polar';
import { checkRateLimit } from '@/lib/ratelimit';

/**
 * Send the signed-in founder into Polar's hosted customer portal.
 *
 * Polar hosts the portal; we neither build nor embed it. Updating a default
 * payment method is only possible on Polar's own page for PCI reasons, and our
 * webhook deliberately treats past_due as entitled (see lib/plan.ts) — so this
 * redirect is the only route a founder has to fix a declined card before Polar
 * revokes the subscription.
 *
 * The URL Polar returns is a bearer credential: it carries a customer session
 * token and the customer's email in its query string, and whoever holds it can
 * read invoices and cancel the subscription. There is no revocation API — once
 * emitted it is valid until it expires and nothing we control shortens that. So
 * it is minted fresh on every click and never stored, cached, or logged. Polar's
 * own docs say the same: "Always generate a fresh link at the moment the
 * customer clicks, rather than storing the URL." If you are here to memoize this
 * call: don't. The saved round trip is worth nothing and the stored URL is a
 * live credential in our database.
 *
 * A stale or failed portal link is not a dead end — Polar 401s it and drops the
 * founder on its email one-time-code form — which is why this route needs no
 * fallback of its own.
 */
export async function GET(req: NextRequest) {
  // Resolved first, like api/survey/preview: the returnUrl handed to Polar must
  // be the public origin. Behind Railway's proxy req.url is https://localhost:8080,
  // which would render a dead "back" button inside Polar's portal.
  const appUrl = publicAppUrl();

  // EVERY exit from this route is a redirect, never a JSON body. This is reached
  // by a founder clicking an anchor, so the response is rendered as a page: a raw
  // {"error":...} blob in a tab is not an error message anyone can act on. Errors
  // go back to /settings with a ?billing= reason the page turns into a notice.
  //
  // The one exception below is a missing app URL, which cannot redirect because
  // there is no origin to build a redirect against.
  //
  // The sibling api/billing/checkout still answers in JSON. That is a real
  // inconsistency and this is the side worth copying — checkout is reached the
  // same way and has the same problem.
  const authResult = requireOrgId(req);
  if ('error' in authResult) {
    return NextResponse.redirect(redirectUrl('/onboarding', req));
  }
  const { orgId } = authResult;

  if (!appUrl) {
    return NextResponse.json(
      { error: 'Server misconfiguration: app URL is missing or not https. Contact support.' },
      { status: 500 },
    );
  }

  // Distinct from the 502 below: no access token is a deployment that never had
  // billing wired, and no amount of retrying will change that.
  if (!isPolarConfigured()) {
    console.error(`Portal requested for org ${orgId} but POLAR_ACCESS_TOKEN is not set`);
    return NextResponse.redirect(new URL('/settings?billing=unconfigured', appUrl), { status: 303 });
  }

  // Each call mints a bearer credential that cannot be revoked and stays valid
  // until it expires, so the number of live credentials per org has to be
  // bounded. The org cookie is SameSite=Lax and this is a GET, which means a
  // third-party page can trigger minting without the founder intending it; the
  // limit is what stops that becoming an unbounded supply. Sized for a human
  // pressing a button — generous for real use, useless for a script.
  const rl = checkRateLimit(`portal:${orgId}`, 10, 600_000);
  if (!rl.allowed) {
    return NextResponse.redirect(new URL('/settings?billing=busy', appUrl), {
      status: 303,
      headers: { 'Retry-After': String(rl.retryAfterSec) },
    });
  }

  try {
    const session = await getPolar().customerSessions.create({
      // organizations.id, written into Polar at checkout creation. Not
      // organizations.polar_customer_id — that column stays NULL until the first
      // subscription webhook lands, so it is empty for an org whose checkout has
      // completed but whose webhook is still in flight.
      externalCustomerId: orgId,
      returnUrl: `${appUrl}/settings`,
    }, {
      // The SDK sets no AbortSignal by default, so without this a stalled Polar
      // API holds the founder's tab and a Node socket open for minutes.
      timeoutMs: 10_000,
    });

    // 303 so the browser follows with GET, matching the checkout route's hop.
    // no-store so no proxy or bfcache retains a header carrying a live credential.
    return NextResponse.redirect(session.customerPortalUrl, {
      status: 303,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    const status = err instanceof PolarError ? err.statusCode : undefined;

    // Which fields Polar's 422 complained about, as `path:error_code` pairs.
    // `loc` and `type` are a field path and a machine error code; `msg`, `input`
    // and `ctx` can echo the submitted value, so they are left out. Without this
    // a 422 is a bare number and a request bug is indistinguishable from the
    // expected unknown-customer case below.
    const validationFields =
      err instanceof HTTPValidationError
        ? (err.detail ?? []).map((d) => `${d.loc.join('.')}:${d.type}`)
        : [];

    // A PolarError's message and body echo Polar's response, so only the numeric
    // status (and the field paths above) is logged. Anything that is not a
    // PolarError came from our side (DNS, timeout, a thrown config error) and
    // carries no Polar credential, so it is safe to log whole.
    if (err instanceof PolarError) {
      const fields = validationFields.length ? ` fields=${validationFields.join(',')}` : '';
      console.error(
        `Polar customer session creation failed for org ${orgId} (status ${status})${fields}`,
      );
    } else {
      console.error(`Polar customer session creation failed for org ${orgId}:`, err);
    }

    // No Polar customer for this org yet — every free-plan org, and anyone who
    // has never reached checkout. An expected state, not an error, so it lands
    // back on settings rather than returning a status code.
    //
    // 404 is the plain resource-lookup answer. 422 is also accepted, but only
    // when the validation error actually names external_customer_id: the SDK
    // wires 422 to HTTPValidationError, which is FastAPI's *request body*
    // validation status, so a blanket `status === 422` would tell a paying
    // founder with a declined card that they have no billing account whenever
    // we send Polar a request it dislikes for any other reason. Both are handled
    // because the SDK declares only 201/422/4XX/5XX here and nothing in it
    // settles which one an unknown externalCustomerId produces — confirm against
    // sandbox and drop the arm that never fires.
    const unknownExternalCustomer =
      err instanceof HTTPValidationError &&
      (err.detail ?? []).some((d) => d.loc.includes('external_customer_id'));

    if (status === 404 || unknownExternalCustomer) {
      return NextResponse.redirect(new URL('/settings?billing=none', appUrl), { status: 303 });
    }

    // The SDK does not retry a 429 by default, and this call shares the org-wide
    // rate-limit bucket with checkout. The founder's browser is the retry.
    if (status === 429) {
      const retryAfter = err instanceof PolarError ? err.headers.get('retry-after') : null;
      return NextResponse.redirect(new URL('/settings?billing=busy', appUrl), {
        status: 303,
        headers: retryAfter ? { 'Retry-After': retryAfter } : undefined,
      });
    }

    return NextResponse.redirect(new URL('/settings?billing=error', appUrl), { status: 303 });
  }
}
