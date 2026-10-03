import type { PoolClient } from 'pg';
import { entitlementForStatus, planForProduct, type Plan } from '@/lib/plan';
import { reportError } from '@/lib/report-error';

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
  /**
   * Set when the plan was kept above what the inputs grant, because the
   * pointer names a subscription with no ledger row (see below). null otherwise.
   */
  held: 'missing_ledger_row' | null;
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
 * One exception: polar_subscription_id naming a subscription with no ledger
 * row. That org went paid before polar_subscriptions existed, or while a
 * rollback to the watermark code (which writes the plan and the pointer, not
 * the ledger) was live, and the recompute cannot see what that subscription
 * is doing. So it never lowers the plan below its current value while that
 * is so: the plan and the pointer are left as they are, the result says
 * `held`, and the operator is told to resync. Raising the plan is still fine,
 * but the pointer stays on the unledgered subscription even then: the pointer
 * is the only record that the hold applies, so moving it to the subscription
 * that raised the plan would let that one's revoke drop an org that may still
 * be paying to free, with nothing reported. The hold ends once an event for
 * that subscription is recorded (the ledger upsert inserts any event for an
 * id it has no row for), its row is added by hand, or an operator clears the
 * pointer for a subscription known to have ended (README, "Deploying
 * fix/launch-hardening", step 4).
 *
 * Must run inside the caller's transaction, after lockOrganization.
 */
export async function recomputeOrgPlan(client: PoolClient, orgId: string): Promise<RecomputedPlan> {
  const org = await client.query<{ comp_plan: CompPlan | null; plan: Plan; polar_subscription_id: string | null }>(
    `SELECT comp_plan, plan, polar_subscription_id FROM organizations WHERE id = $1`,
    [orgId],
  );
  const compPlan = org.rows[0]?.comp_plan ?? null;
  const currentPlan = org.rows[0]?.plan ?? 'free';
  const pointer = org.rows[0]?.polar_subscription_id ?? null;

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

  const derived = higher(compPlan ?? 'free', best?.tier ?? 'free');

  const unledgered = pointer !== null && !rows.some((row) => row.id === pointer);
  if (unledgered && TIER_RANK[derived] < TIER_RANK[currentPlan]) {
    reportError(
      'billing.recompute',
      new Error(
        `Polar subscription ${pointer} (organizations.polar_subscription_id) has no row in ` +
          `polar_subscriptions, so the recompute cannot see it. Kept plan ${currentPlan} instead of ` +
          `lowering it to ${derived}; it stays held until an event for that subscription is recorded, ` +
          'its row is added from Polar, or (if it has ended) the pointer is cleared — README, ' +
          '"Deploying fix/launch-hardening", step 4.',
      ),
      { orgId, subscriptionId: pointer, step: 'missing_ledger_row' },
    );
    return { plan: currentPlan, polarSubscriptionId: pointer, held: 'missing_ledger_row' };
  }

  const plan = derived;
  // Unledgered: kept where it is (see above), even though the plan may rise.
  const nextPointer = unledgered ? pointer : (best?.subscriptionId ?? rows[0]?.id ?? null);

  const updated = await client.query<{ polar_subscription_id: string | null }>(
    `UPDATE organizations
     SET plan = $2,
         polar_subscription_id = COALESCE($3, polar_subscription_id)
     WHERE id = $1
     RETURNING polar_subscription_id`,
    [orgId, plan, nextPointer],
  );

  return { plan, polarSubscriptionId: updated.rows[0]?.polar_subscription_id ?? null, held: null };
}
