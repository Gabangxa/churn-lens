import { NextRequest, NextResponse } from 'next/server';
import { queryOne } from '@/lib/db';
import { requireOrgId } from '@/lib/auth';
import { publicAppUrl } from '@/lib/app-url';
import { getPolar } from '@/lib/polar';
import { isPlan, type Plan } from '@/lib/plan';

/**
 * Start a Polar checkout for the signed-in org and redirect the founder to it.
 *
 * externalCustomerId carries organizations.id into Polar, which echoes it back
 * on every subsequent subscription webhook. That is the whole mapping: without
 * it the webhook receives a payment it cannot attribute to anyone.
 */

function productIdForPlan(plan: Plan): string | undefined {
  if (plan === 'starter') return process.env.POLAR_PRODUCT_STARTER;
  if (plan === 'growth') return process.env.POLAR_PRODUCT_GROWTH;
  return undefined;
}

export async function GET(req: NextRequest) {
  const authResult = requireOrgId(req);
  if ('error' in authResult) return authResult.error;
  const { orgId } = authResult;

  const plan = req.nextUrl.searchParams.get('plan');
  if (!isPlan(plan) || plan === 'free') {
    return NextResponse.json(
      { error: 'plan must be starter or growth' },
      { status: 400 },
    );
  }

  const productId = productIdForPlan(plan);
  if (!productId) {
    console.error(`No Polar product configured for plan ${plan}`);
    return NextResponse.json(
      { error: 'Billing is not configured for this plan yet.' },
      { status: 503 },
    );
  }

  // Checkout resolves against the public app URL, never req.url — a success URL
  // on the wrong host sends a paying customer somewhere that is not us.
  const appUrl = publicAppUrl();
  if (!appUrl) {
    return NextResponse.json(
      { error: 'Server misconfiguration: app URL is missing or not https.' },
      { status: 500 },
    );
  }

  // Prefill the email so the founder is not asked for something we already know.
  const owner = await queryOne<{ email: string }>(
    `SELECT email FROM users WHERE org_id = $1 AND role = 'owner' LIMIT 1`,
    [orgId],
  );

  try {
    const checkout = await getPolar().checkouts.create({
      products: [productId],
      externalCustomerId: orgId,
      customerEmail: owner?.email ?? undefined,
      successUrl: `${appUrl}/settings?checkout=success`,
      // Copied onto the resulting subscription, so the plan this checkout was
      // for stays legible in Polar's dashboard next to the raw product id.
      metadata: { orgId, plan },
    });

    return NextResponse.redirect(checkout.url, { status: 303 });
  } catch (err) {
    console.error(`Polar checkout creation failed for org ${orgId}:`, err);
    return NextResponse.json(
      { error: 'Could not start checkout. Please try again.' },
      { status: 502 },
    );
  }
}
