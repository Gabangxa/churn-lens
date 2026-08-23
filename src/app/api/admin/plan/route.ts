import { NextResponse } from 'next/server';
import { execute } from '@/lib/db';
import { verifyCronSecret } from '@/lib/auth';
import { PLANS, isPlan } from '@/lib/plan';

/**
 * Set an organization's plan directly.
 *
 * Exists so paid features are reachable without Polar. Nothing else in the app
 * writes organizations.plan, so every org sits on the schema default of 'free'
 * and the weekly clustering run — which selects plan IN ('starter','growth') —
 * processes none of them. Billing being unbuilt should not be the same thing as
 * the product being unusable.
 *
 * It is also the comp path: grandfathering an early customer or refunding a
 * broken month should not require a checkout session.
 *
 * Guarded by CRON_SECRET, the same shared secret the cron routes use. That is
 * deliberate: this is an operator tool with no UI, and adding a second
 * privileged auth scheme for one route would be more surface than it removes.
 * It means anyone holding CRON_SECRET can grant themselves a paid plan, which
 * is acceptable only because that secret is already trusted to trigger billing-
 * relevant jobs. If this ever grows a UI, it needs real admin auth first.
 */
export async function POST(req: Request) {
  if (!verifyCronSecret(req.headers.get('authorization'))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Body must be JSON' }, { status: 400 });
  }

  const { orgId, plan } = (body ?? {}) as { orgId?: unknown; plan?: unknown };

  if (typeof orgId !== 'string' || orgId.length === 0) {
    return NextResponse.json({ error: 'orgId is required' }, { status: 400 });
  }

  // The column carries a CHECK constraint, so an invalid plan would fail at the
  // database with a 500. Reject it here instead, naming the valid values.
  if (!isPlan(plan)) {
    return NextResponse.json(
      { error: `plan must be one of: ${PLANS.join(', ')}` },
      { status: 400 },
    );
  }

  let updated: number;
  try {
    updated = await execute(
      `UPDATE organizations SET plan = $1 WHERE id = $2`,
      [plan, orgId],
    );
  } catch (err) {
    // An orgId that is not a valid uuid reaches Postgres as a cast error rather
    // than a no-op, so it must not surface as an unhandled 500.
    console.error(`Failed to set plan for org ${orgId}:`, err);
    return NextResponse.json({ error: 'Failed to set plan' }, { status: 500 });
  }

  if (updated === 0) {
    return NextResponse.json({ error: 'Organization not found' }, { status: 404 });
  }

  console.log(`Plan for org ${orgId} set to ${plan} via admin route`);
  return NextResponse.json({ orgId, plan });
}
