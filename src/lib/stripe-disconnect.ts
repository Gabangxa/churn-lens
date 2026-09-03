import { query, queryOne } from '@/lib/db';
import { decryptApiKey } from '@/lib/crypto';
import Stripe from 'stripe';

/**
 * Disconnects an org's Stripe integration: best-effort deletes the webhook
 * endpoint ChurnLens registered, then clears the stored credentials.
 *
 * Shared by the founder-initiated Settings disconnect (DELETE
 * /api/settings/disconnect) and the purge job's hard-delete-on-account-deletion
 * path (POST /api/purge), so the two can never drift apart on what "disconnected"
 * means. Neither caller needs the org to exist first — a missing row, or one
 * with no Stripe key stored, just makes the webhook-delete step a no-op and the
 * UPDATE below affect zero rows.
 */
export async function disconnectStripe(orgId: string): Promise<void> {
  const org = await queryOne<{
    stripe_api_key_enc: string | null;
    stripe_webhook_id: string | null;
  }>(
    'SELECT stripe_api_key_enc, stripe_webhook_id FROM organizations WHERE id = $1',
    [orgId],
  );

  // Delete only the webhook endpoint ChurnLens registered — never touch others.
  if (org?.stripe_api_key_enc && org.stripe_webhook_id) {
    try {
      const apiKey = decryptApiKey(org.stripe_api_key_enc);
      const stripeClient = new Stripe(apiKey, { apiVersion: '2024-04-10', typescript: true });
      await stripeClient.webhookEndpoints.del(org.stripe_webhook_id);
    } catch (err) {
      // Log but don't block disconnect — the org's credentials must be cleared
      // (or the org row deleted, for the purge caller) regardless of whether
      // Stripe's own cleanup succeeded.
      console.error(`Failed to delete Stripe webhook endpoint for org ${orgId}:`, err);
    }
  }

  await query(
    `UPDATE organizations
     SET stripe_api_key_enc = NULL,
         stripe_account_id = NULL,
         stripe_webhook_id = NULL,
         stripe_webhook_secret_enc = NULL
     WHERE id = $1`,
    [orgId],
  );
}
