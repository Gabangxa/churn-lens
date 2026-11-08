import { query, queryOne } from '@/lib/db';
import { decryptApiKey } from '@/lib/crypto';
import Stripe from 'stripe';
import { reportError } from '@/lib/report-error';

/**
 * Stripe answers that need no operator: 401/403 mean the founder already
 * revoked or restricted the key (nobody can delete the endpoint with it now,
 * and Stripe disables an endpoint that keeps failing), and 404 means the
 * endpoint is already gone. Read off statusCode, which every Stripe API error
 * carries, rather than the error classes.
 */
function isExpectedEndpointDeleteFailure(err: unknown): boolean {
  const statusCode = (err as { statusCode?: unknown } | null)?.statusCode;
  return statusCode === 401 || statusCode === 403 || statusCode === 404;
}

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
      // Don't block disconnect — the org's credentials must be cleared (or the
      // org row deleted, for the purge caller) regardless of whether Stripe's
      // own cleanup succeeded. Anything but the expected answers above (a
      // Stripe outage, a key that no longer decrypts) leaves a live endpoint
      // on the founder's account that someone has to remove by hand.
      if (isExpectedEndpointDeleteFailure(err)) {
        console.warn(`Stripe webhook endpoint for org ${orgId} was not deleted (${String(err)}).`);
      } else {
        reportError('stripe.disconnect', err, { orgId, step: 'webhook_delete' });
      }
    }
  }

  // Everything that described the connected account goes with its key: the
  // business name read from it (or survey copy keeps naming a business that
  // is no longer connected, and the dashboard never asks for a name) and the
  // record that Stripe rejected its key (a flag about a key no longer stored).
  await query(
    `UPDATE organizations
     SET stripe_api_key_enc = NULL,
         stripe_account_id = NULL,
         stripe_webhook_id = NULL,
         stripe_webhook_secret_enc = NULL,
         stripe_business_name = NULL,
         stripe_key_invalid_at = NULL
     WHERE id = $1`,
    [orgId],
  );
}
