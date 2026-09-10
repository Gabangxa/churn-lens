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
    await page.getByRole('button', { name: 'Save and activate' }).click();

    await expect(page.getByText(/restricted API key \(starts with rk_\)/)).toBeVisible();

    const org = await queryOne<{ stripe_api_key_enc: string | null }>(
      'SELECT stripe_api_key_enc FROM organizations WHERE id = $1',
      [orgId],
    );
    expect(org!.stripe_api_key_enc).toBeNull();
  });
});
