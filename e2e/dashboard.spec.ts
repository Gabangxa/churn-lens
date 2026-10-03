import { expect, test } from '@playwright/test';
// Pure module (no next/, no db) — safe to import into a Playwright process.
import { legalFooterReady } from '../src/lib/legal';
import { closeDb, daysAgo, query, seedOrg, seedSurveyResponse, uniqueEmail } from './helpers/db';
import { loginAs } from './helpers/session';

/**
 * The dashboard's status line is the only place a founder learns whether a
 * cancellation will actually be surveyed. The webhook skips silently with a
 * 200 for several reasons, and the status line used to say "surveys firing
 * automatically" through all of them.
 */
test.describe('dashboard status', () => {
  test.afterAll(async () => {
    await closeDb();
  });

  test('a connected org is told the truth about whether surveys are sending', async ({ page }) => {
    const email = uniqueEmail('status');
    const { orgId } = await seedOrg({ email, withStripeKey: true });

    await loginAs(page, { orgId, email, redirectTo: '/dashboard' });
    await page.waitForURL((url) => url.pathname === '/dashboard');

    // Gated on legal.ts like legal.spec.ts: filling the placeholders in (the
    // real launch task) flips which line is correct, not whether this passes.
    if (legalFooterReady()) {
      await expect(page.getByText('surveys sending automatically')).toBeVisible();
      // The webhook skips involuntary churn; "automatically" must not imply every cancellation.
      await expect(page.getByText(/failed or disputed payment are not surveyed/)).toBeVisible();
    } else {
      await expect(page.getByText(/Surveys are paused on our side/)).toBeVisible();
      await expect(page.getByText('surveys sending automatically')).toHaveCount(0);
    }
  });

  test('an org whose Stripe key was rejected is told to reconnect', async ({ page }) => {
    const email = uniqueEmail('keyrejected');
    const { orgId } = await seedOrg({ email, withStripeKey: true });
    // What the Stripe webhook records when Stripe answers 401/403 for the stored key.
    await query('UPDATE organizations SET stripe_key_invalid_at = now() WHERE id = $1', [orgId]);

    await loginAs(page, { orgId, email, redirectTo: '/dashboard' });
    await page.waitForURL((url) => url.pathname === '/dashboard');

    // Shown whether or not legal.ts is filled: it outranks the platform pause.
    await expect(page.getByText(/Stripe has been rejecting your API key/)).toBeVisible();
    await expect(page.getByRole('link', { name: 'Reconnect Stripe with a new key' })).toHaveAttribute(
      'href',
      '/onboarding',
    );
    await expect(page.getByText('surveys sending automatically')).toHaveCount(0);
  });

  test('a free org with responses is not promised AI themes', async ({ page }) => {
    const email = uniqueEmail('freethemes');
    const { orgId } = await seedOrg({ email, withStripeKey: true });
    await seedSurveyResponse(orgId, { customerEmail: 'churned@example.com', createdAt: daysAgo(1) });

    await loginAs(page, { orgId, email, redirectTo: '/dashboard' });
    await page.waitForURL((url) => url.pathname === '/dashboard');

    await expect(page.getByText('AI themes are included in the Starter and Growth plans')).toBeVisible();
    await expect(page.getByText(/themes generate Monday/)).toHaveCount(0);
  });
});
