import { expect, test } from '@playwright/test';
import { closeDb, queryOne, seedOrg, uniqueEmail } from './helpers/db';
import { loginAs } from './helpers/session';

/**
 * Onboarding used to collect an email and create the org itself, which is the
 * account-takeover hole the auth rewrite closed. The form must now be a
 * key-only form behind a session — an email field reappearing here is a
 * regression with security consequences, not a cosmetic one.
 */
test.describe('onboarding', () => {
  test.afterAll(async () => {
    await closeDb();
  });

  test('asks a signed-in founder for a key only, and rejects a non-restricted one', async ({ page }) => {
    const email = uniqueEmail('onboard');
    const { orgId } = await seedOrg({ email });

    await loginAs(page, { orgId, email, redirectTo: '/onboarding' });
    await page.waitForURL((url) => url.pathname === '/onboarding');

    await expect(page.getByLabel('Stripe restricted API key')).toBeVisible();
    await expect(page.locator('input[type="email"]')).toHaveCount(0);

    await page.getByLabel('Stripe restricted API key').fill('sk_live_notrestricted');

    // Terms/DPA acceptance is a deliberate act: never pre-ticked, and the form
    // will not submit without it.
    const agree = page.getByLabel('I agree to the Terms of Service and Data Processing Agreement');
    await expect(agree).not.toBeChecked();
    await expect(page.getByRole('button', { name: 'Save and activate' })).toBeDisabled();
    await agree.check();

    await page.getByRole('button', { name: 'Save and activate' }).click();

    await expect(page.getByText(/restricted API key \(starts with rk_\)/)).toBeVisible();

    // A refused key records nothing — not the key, and not the acceptance
    // either, which connect only ever writes alongside a stored key.
    const org = await queryOne<{
      stripe_api_key_enc: string | null;
      legal_accepted_version: string | null;
    }>('SELECT stripe_api_key_enc, legal_accepted_version FROM organizations WHERE id = $1', [orgId]);
    expect(org!.stripe_api_key_enc).toBeNull();
    expect(org!.legal_accepted_version).toBeNull();
  });
});
