import { NextResponse } from 'next/server';
import { withTransaction } from '@/lib/db';
import { verifyCronSecret } from '@/lib/auth';
import { PLANS, isPlan } from '@/lib/plan';
import { lockOrganization, recomputeOrgPlan, type CompPlan, type RecomputedPlan } from '@/lib/org-plan';

/**
 * Comp an organization onto a paid plan, or take the comp away.
 *
 * Exists so paid features are reachable without Polar: grandfathering an early
 * customer or refunding a broken month should not require a checkout session.
 *
 * The comp is stored in organizations.comp_plan, not written over
 * organizations.plan. It used to be, and the next Polar event for the org (a
 * renewal, an expired checkout) silently overwrote it. Now it is one input to
 * the same recompute the webhook runs (src/lib/org-plan.ts): the org gets the
 * higher of its comp and what its subscriptions pay for. So `plan: 'free'`
 * (or null) removes the comp — it does not take a paying org off the plan its
 * subscription pays for. The response says which plan the org ended up on.
 *
 * Guarded by CRON_SECRET, the same shared secret the cron routes use. That is
 * deliberate: this is an operator tool with no UI, and adding a second
 * privileged auth scheme for one route would be more surface than it removes.
 * It means anyone holding CRON_SECRET can grant themselves a paid plan, which
 * is acceptable only because that secret is already trusted to trigger billing-
 * relevant jobs. If this ever grows a UI, it needs real admin auth first.
 */

/** organizations.id. Anything else is an operator typo, and Postgres would throw on the cast. */
const ORG_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

  if (typeof orgId !== 'string' || !ORG_ID.test(orgId)) {
    return NextResponse.json({ error: 'orgId must be an organization id (uuid)' }, { status: 400 });
  }

  // The column carries a CHECK constraint, so an invalid plan would fail at the
  // database with a 500. Reject it here instead, naming the valid values.
  if (plan !== null && !isPlan(plan)) {
    return NextResponse.json(
      { error: `plan must be one of: ${PLANS.join(', ')} (free or null removes the comp)` },
      { status: 400 },
    );
  }
  const compPlan: CompPlan | null = plan === null || plan === 'free' ? null : plan;

  let result: RecomputedPlan | null;
  try {
    result = await withTransaction(async (client) => {
      // The same lock the webhook takes, so a delivery landing mid-request
      // recomputes after this comp is committed, not over a stale snapshot.
      if (!(await lockOrganization(client, orgId))) return null;
      await client.query(`UPDATE organizations SET comp_plan = $2 WHERE id = $1`, [orgId, compPlan]);
      return recomputeOrgPlan(client, orgId);
    });
  } catch (err) {
    console.error(`Failed to set the comp plan for org ${orgId}:`, err);
    return NextResponse.json({ error: 'Failed to set plan' }, { status: 500 });
  }

  if (!result) {
    return NextResponse.json({ error: 'Organization not found' }, { status: 404 });
  }

  console.log(`Comp for org ${orgId} set to ${compPlan ?? 'none'} via admin route; plan is now ${result.plan}`);
  return NextResponse.json({ orgId, compPlan, plan: result.plan });
}
