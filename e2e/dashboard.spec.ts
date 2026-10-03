import { expect, test } from '@playwright/test';
// Pure module (no next/, no db) — safe to import into a Playwright process.
import { legalFooterReady } from '../src/lib/legal';
import { currentLegalDocsVersion } from '../src/lib/legal-version';
import { closeDb, daysAgo, query, queryOne, seedOrg, seedSurveyResponse, uniqueEmail } from './helpers/db';
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
    const { orgId } = await seedOrg({ email, withStripeKey: true, withStripeWebhook: true });

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

  test('an org with a key but no webhook endpoint is told to finish connecting, not that surveys are sending', async ({ page }) => {
    // What a first connect whose webhook registration failed used to leave
    // behind: the key stored, no endpoint, so no event can ever arrive.
    const email = uniqueEmail('setupincomplete');
    const { orgId } = await seedOrg({ email, withStripeKey: true });

    await loginAs(page, { orgId, email, redirectTo: '/dashboard' });
    // Straight to the dashboard whichever page sign-in chose for this org.
    await page.goto('/dashboard');

    // Shown whether or not legal.ts is filled: it outranks the platform pause.
    await expect(page.getByText(/Stripe setup is incomplete/)).toBeVisible();
    await expect(page.getByRole('link', { name: 'Finish connecting Stripe' })).toHaveAttribute('href', '/onboarding');
    await expect(page.getByText('surveys sending automatically')).toHaveCount(0);
  });

  test('an org whose Stripe key was rejected is told to reconnect', async ({ page }) => {
    const email = uniqueEmail('keyrejected');
    const { orgId } = await seedOrg({ email, withStripeKey: true, withStripeWebhook: true });
    // What the Stripe webhook records when Stripe answers 401/403 for the
    // stored key, or the key is for another account or mode than the events.
    await query('UPDATE organizations SET stripe_key_invalid_at = now() WHERE id = $1', [orgId]);

    await loginAs(page, { orgId, email, redirectTo: '/dashboard' });
    await page.waitForURL((url) => url.pathname === '/dashboard');

    // Shown whether or not legal.ts is filled: it outranks the platform pause.
    await expect(page.getByText(/Stripe has rejected your API key, or the key belongs to a different Stripe account or mode/)).toBeVisible();
    await expect(page.getByRole('link', { name: 'Reconnect Stripe with a new key' })).toHaveAttribute(
      'href',
      '/onboarding',
    );
    await expect(page.getByText('surveys sending automatically')).toHaveCount(0);
  });

  test('an org whose surveys would name no business is asked for a name, until it has one', async ({ page }) => {
    // Most keys cannot read the Stripe account name, so without a display
    // name the survey email never says which business is asking.
    const email = uniqueEmail('noname');
    const { orgId } = await seedOrg({ email, withStripeKey: true, withStripeWebhook: true });

    await loginAs(page, { orgId, email, redirectTo: '/dashboard' });
    await page.waitForURL((url) => url.pathname === '/dashboard');

    await expect(page.getByText(/Your survey emails don't say which business is asking/)).toBeVisible();
    await expect(page.getByRole('link', { name: 'Add your business name in Settings' })).toHaveAttribute(
      'href',
      '/settings',
    );

    // What saving a display name in Settings stores.
    await query('UPDATE organizations SET survey_config = $1 WHERE id = $2', [
      JSON.stringify({ display_name: 'Acme E2E' }),
      orgId,
    ]);
    await page.reload();

    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    await expect(page.getByText(/Your survey emails don't say which business is asking/)).toHaveCount(0);
  });

  test('a free org with responses is not promised AI themes', async ({ page }) => {
    const email = uniqueEmail('freethemes');
    const { orgId } = await seedOrg({ email, withStripeKey: true, withStripeWebhook: true });
    await seedSurveyResponse(orgId, { customerEmail: 'churned@example.com', createdAt: daysAgo(1) });

    await loginAs(page, { orgId, email, redirectTo: '/dashboard' });
    await page.waitForURL((url) => url.pathname === '/dashboard');

    await expect(page.getByText('AI themes are included in the Starter and Growth plans')).toBeVisible();
    await expect(page.getByText(/themes generate Monday/)).toHaveCount(0);
  });

  test('an org with no Terms/DPA acceptance on record is asked, and "I agree" records it', async ({ page }) => {
    // seedOrg leaves both legal_accepted_* columns NULL — exactly the state of
    // every org that connected before acceptance was recorded.
    const email = uniqueEmail('legalaccept');
    const { orgId } = await seedOrg({ email, withStripeKey: true, withStripeWebhook: true });

    await loginAs(page, { orgId, email, redirectTo: '/dashboard' });
    await page.waitForURL((url) => url.pathname === '/dashboard');

    const agree = page.getByRole('button', { name: 'I agree' });
    await expect(agree).toBeVisible();
    await agree.click();
    // The banner only hides once the route has answered 200, so the row is
    // already written by the time this passes.
    await expect(agree).toHaveCount(0);

    const org = await queryOne<{ legal_accepted_version: string | null; legal_accepted_at: Date | null }>(
      'SELECT legal_accepted_version, legal_accepted_at FROM organizations WHERE id = $1',
      [orgId],
    );
    expect(org!.legal_accepted_version).toBe(currentLegalDocsVersion());
    expect(org!.legal_accepted_at).not.toBeNull();
    // And in the history that later versions never overwrite.
    expect(
      await query('SELECT version, source FROM legal_acceptances WHERE org_id = $1', [orgId]),
    ).toEqual([{ version: currentLegalDocsVersion(), source: 'banner' }]);

    // Recorded, not merely hidden: a fresh load does not ask again.
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'I agree' })).toHaveCount(0);
  });
});
