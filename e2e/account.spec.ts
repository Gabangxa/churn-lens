import { expect, test, type Page } from '@playwright/test';
import { closeDb, query, queryOne, refuseOrgColumnWrites, seedOrg, uniqueEmail } from './helpers/db';
import { atLoginWithNext, loginAs } from './helpers/session';

/**
 * Account deletion is a POPIA/GDPR erasure promise with a UI in front of it.
 * The route has unit tests; what they cannot show is that the two-step
 * confirm actually reaches the route, that the session really ends, and that
 * the Stripe columns are cleared in the same breath as the deletion request
 * (they must be: the integration stops immediately, the erasure itself waits
 * out the 30-day grace period in the purge job).
 */
const SESSION_COOKIE = 'churnlens_org_id';

/** Sign in as a fresh org and open Settings. Sign-in lands an unconnected org on onboarding. */
async function openSettingsAs(page: Page, email: string, orgId: string): Promise<void> {
  await loginAs(page, { orgId, email });
  await page.waitForURL((url) => url.pathname === '/onboarding');
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Account' })).toBeVisible();
}

/** The two-step confirm, waiting for the route's answer rather than for a navigation. */
async function deleteAccount(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^delete account/i }).click();
  const answered = page.waitForResponse(
    (res) => res.url().endsWith('/api/settings/account/delete') && res.request().method() === 'POST',
  );
  await page.getByRole('button', { name: /yes, delete/i }).click();
  expect((await answered).status()).toBe(200);
}

async function sessionCookie(page: Page) {
  return (await page.context().cookies()).find((c) => c.name === SESSION_COOKIE);
}

async function deletionRequestedAt(orgId: string): Promise<string | null> {
  const org = await queryOne<{ deletion_requested_at: string | null }>(
    'SELECT deletion_requested_at FROM organizations WHERE id = $1',
    [orgId],
  );
  return org!.deletion_requested_at;
}

test.describe('account deletion', () => {
  test.afterAll(async () => {
    await closeDb();
  });

  test('a founder can delete their account from settings and is signed out', async ({ page }) => {
    const email = uniqueEmail('delete');
    // Key only, no webhook: disconnectStripe then has no endpoint to delete,
    // so deletion never tries to decrypt the placeholder key. Sign-in sends a
    // half-connected org to onboarding, so Settings is opened directly.
    const { orgId } = await seedOrg({ email, withStripeKey: true });

    await loginAs(page, { orgId, email });
    await page.waitForURL((url) => url.pathname === '/onboarding');
    await page.goto('/settings');

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

  // Each step after the deletion request is non-fatal in the route, which
  // still answers 200 and names what failed. Before the page read those
  // names, it navigated home as if every device had been signed out and
  // Stripe disconnected. The failures are real ones: the database refuses
  // the write, and the route's own error handling runs.

  test('a deletion that could not sign out the other devices says so, and stays on the page', async ({ page }) => {
    const email = uniqueEmail('delsessions');
    const { orgId } = await seedOrg({ email });
    await openSettingsAs(page, email, orgId);

    const allowWrites = await refuseOrgColumnWrites(orgId, 'sessions_valid_after');
    try {
      await deleteAccount(page);
      await expect(page.getByText('your other devices may still be signed in')).toBeVisible();
    } finally {
      await allowWrites();
    }

    expect(new URL(page.url()).pathname).toBe('/settings');
    // Deletion itself went through, and the page now says so.
    expect(await deletionRequestedAt(orgId)).not.toBeNull();
    await expect(page.getByRole('button', { name: 'Deletion requested' })).toBeDisabled();
    // This browser is signed out regardless: clearing its cookie needs no database.
    expect(await sessionCookie(page)).toBeUndefined();
  });

  test('a deletion that could not disconnect Stripe tells the founder how to cut it off', async ({ page }) => {
    const email = uniqueEmail('delstripe');
    // Key only, no webhook: disconnectStripe goes straight to clearing the
    // columns, which is the write refused here.
    const { orgId } = await seedOrg({ email, withStripeKey: true });
    await openSettingsAs(page, email, orgId);

    const allowWrites = await refuseOrgColumnWrites(orgId, 'stripe_api_key_enc');
    try {
      await deleteAccount(page);
      await expect(page.getByText('We could not disconnect Stripe.')).toBeVisible();
    } finally {
      await allowWrites();
    }

    expect(new URL(page.url()).pathname).toBe('/settings');
    await expect(page.getByText('Developers → Webhooks')).toBeVisible();
    const org = await queryOne<{ stripe_api_key_enc: string | null }>(
      'SELECT stripe_api_key_enc FROM organizations WHERE id = $1',
      [orgId],
    );
    expect(org!.stripe_api_key_enc).not.toBeNull();
    expect(await deletionRequestedAt(orgId)).not.toBeNull();
  });

  test('a deletion whose Polar revoke failed says this and every other device stay signed in', async ({ page }) => {
    // POLAR_ACCESS_TOKEN is not set for the e2e server, so revoking any
    // subscription fails the way a Polar outage would.
    const email = uniqueEmail('delpolar');
    const { orgId } = await seedOrg({ email });
    await query('UPDATE organizations SET polar_subscription_id = $1 WHERE id = $2', [
      'sub_e2e_placeholder_not_real',
      orgId,
    ]);
    await openSettingsAs(page, email, orgId);

    await deleteAccount(page);

    await expect(page.getByText('could not automatically cancel your Polar subscription')).toBeVisible();
    await expect(page.getByText('You are still signed in here and on your other devices')).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/settings');
    // Kept on purpose, so the portal link in the notice works.
    expect(await sessionCookie(page)).toBeDefined();
    const org = await queryOne<{ sessions_valid_after: string | null }>(
      'SELECT sessions_valid_after FROM organizations WHERE id = $1',
      [orgId],
    );
    expect(org!.sessions_valid_after).toBeNull();
  });
});
