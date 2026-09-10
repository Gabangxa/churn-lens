import { expect, test } from '@playwright/test';
import { closeDb, queryOne, seedOrg, uniqueEmail } from './helpers/db';
import { atLoginWithNext, loginAs } from './helpers/session';

/**
 * Account deletion is a POPIA/GDPR erasure promise with a UI in front of it.
 * The route has unit tests; what they cannot show is that the two-step
 * confirm actually reaches the route, that the session really ends, and that
 * the Stripe columns are cleared in the same breath as the deletion request
 * (they must be: the integration stops immediately, the erasure itself waits
 * out the 30-day grace period in the purge job).
 */
test.describe('account deletion', () => {
  test.afterAll(async () => {
    await closeDb();
  });

  test('a founder can delete their account from settings and is signed out', async ({ page }) => {
    const email = uniqueEmail('delete');
    const { orgId } = await seedOrg({ email, withStripeKey: true });

    await loginAs(page, { orgId, email, redirectTo: '/settings' });
    await page.waitForURL((url) => url.pathname === '/settings');

    const accountCard = page.getByRole('heading', { name: 'Account' });
    await expect(accountCard).toBeVisible();

    // Matched loosely: this flow must keep working when the copy is reworded
    // (the ellipsis in "Delete account…" is a typographic one, not a period).
    await page.getByRole('button', { name: /^delete account/i }).click();
    await page.getByRole('button', { name: /yes, delete/i }).click();

    // The page navigates home once the session cookie is gone.
    await page.waitForURL((url) => url.pathname === '/');

    const org = await queryOne<{
      deletion_requested_at: string | null;
      stripe_api_key_enc: string | null;
      stripe_account_id: string | null;
      stripe_webhook_id: string | null;
      stripe_webhook_secret_enc: string | null;
    }>(
      `SELECT deletion_requested_at, stripe_api_key_enc, stripe_account_id,
              stripe_webhook_id, stripe_webhook_secret_enc
       FROM organizations WHERE id = $1`,
      [orgId],
    );
    expect(org).not.toBeNull();
    expect(org!.deletion_requested_at).not.toBeNull();
    expect(org!.stripe_api_key_enc).toBeNull();
    expect(org!.stripe_account_id).toBeNull();
    expect(org!.stripe_webhook_id).toBeNull();
    expect(org!.stripe_webhook_secret_enc).toBeNull();

    // The row survives the grace period, but this browser must not still be
    // holding a usable session for it.
    await page.goto('/settings');
    await page.waitForURL(atLoginWithNext('/settings'));
  });
});
