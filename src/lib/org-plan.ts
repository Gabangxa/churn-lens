import type { PoolClient } from 'pg';
import { entitlementForStatus, planForProduct, type Plan } from '@/lib/plan';

/**
 * Where organizations.plan comes from.
 *
 * Two writers used to set the column directly, and each overwrote the other:
 * the Polar webhook (one subscription pointer, one watermark per org) and the
 * admin comp route. Now neither writes `plan` itself. Each records its own
 * input — a row per Polar subscription in polar_subscriptions, a hand-granted
 * comp in organizations.comp_plan — and calls recomputeOrgPlan, which derives
 * the plan from all of them at once. That makes the result independent of the
 * order the inputs arrived in, which webhook delivery does not guarantee.
 *
 * Everything else in the app keeps reading organizations.plan.
 */

/** A comp is a paid tier; "no comp" is NULL, not 'free'. */
export type CompPlan = Exclude<Plan, 'free'>;

const TIER_RANK: Record<Plan, number> = { free: 0, starter: 1, growth: 2 };

function higher(a: Plan, b: Plan): Plan {
  return TIER_RANK[a] >= TIER_RANK[b] ? a : b;
}

/**
 * Take the org row lock for the rest of the caller's transaction, or report
 * that the org does not exist.
 *
 * Every writer of a recompute input takes this lock first, so two writers for
 * one org (two webhook deliveries, a delivery and an admin comp) run one after
 * the other: the second recomputes over the first one's committed input
 * instead of over a snapshot that is missing it.
 */
export async function lockOrganization(client: PoolClient, orgId: string): Promise<boolean> {
  const { rowCount } = await client.query(`SELECT 1 FROM organizations WHERE id = $1 FOR UPDATE`, [orgId]);
  return (rowCount ?? 0) > 0;
}

export interface RecomputedPlan {
  plan: Plan;
  /** The subscription the plan came from; see below. */
  polarSubscriptionId: string | null;
}

/**
 * Derive and write organizations.plan: the higher of the org's comp and the
 * best tier among its subscriptions that currently grant one.
 *
 * A subscription grants its product's tier while plan.ts calls its status
 * entitled (past_due included, on purpose). A product that maps to no plan
 * grants nothing — refusing to guess a tier, as plan.ts says; the webhook
 * reports it when that subscription's event arrives.
 *
 * polar_subscription_id becomes the subscription granting the top tier, else
 * the most recently modified one, else is left as it was. It is no longer what
 * the plan follows; it marks that the org has touched Polar (the purge's
 * abandoned-signup check) and keeps the old code sane after a rollback.
 *
 * Must run inside the caller's transaction, after lockOrganization.
 */
export async function recomputeOrgPlan(client: PoolClient, orgId: string): Promise<RecomputedPlan> {
  const org = await client.query<{ comp_plan: CompPlan | null }>(
    `SELECT comp_plan FROM organizations WHERE id = $1`,
    [orgId],
  );
  const compPlan = org.rows[0]?.comp_plan ?? null;

  // Newest first, so among equal tiers the most recently modified one wins
  // the pointer, and an org with nothing granting points at its latest.
  const { rows } = await client.query<{ id: string; status: string; product_id: string }>(
    `SELECT id, status, product_id FROM polar_subscriptions
     WHERE org_id = $1
     ORDER BY modified_at DESC, id`,
    [orgId],
  );

  let best: { tier: Plan; subscriptionId: string } | null = null;
  for (const row of rows) {
    if (entitlementForStatus(row.status) !== 'grant') continue;
    const tier = planForProduct(row.product_id);
    if (!tier) continue;
    if (!best || TIER_RANK[tier] > TIER_RANK[best.tier]) best = { tier, subscriptionId: row.id };
  }

  const plan = higher(compPlan ?? 'free', best?.tier ?? 'free');

  const updated = await client.query<{ polar_subscription_id: string | null }>(
    `UPDATE organizations
     SET plan = $2,
         polar_subscription_id = COALESCE($3, polar_subscription_id)
     WHERE id = $1
     RETURNING polar_subscription_id`,
    [orgId, plan, best?.subscriptionId ?? rows[0]?.id ?? null],
  );

  return { plan, polarSubscriptionId: updated.rows[0]?.polar_subscription_id ?? null };
}
