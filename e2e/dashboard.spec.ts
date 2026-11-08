import { expect, test } from '@playwright/test';
// Pure module (no next/, no db) — safe to import into a Playwright process.
import { legalFooterReady } from '../src/lib/legal';
import { closeDb, daysAgo, seedOrg, seedSurveyResponse, uniqueEmail } from './helpers/db';
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
    } else {
      await expect(page.getByText(/Surveys are paused on our side/)).toBeVisible();
      await expect(page.getByText('surveys sending automatically')).toHaveCount(0);
    }
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
