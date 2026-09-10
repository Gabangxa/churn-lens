import { expect, test } from '@playwright/test';

/**
 * The landing page's links are the top of the funnel, and one of them used to
 * be wrong in a way no unit test could see: /onboarding is session-gated now,
 * so any anchor still pointing there sends a first-time visitor to a redirect
 * instead of a signup form, and a pricing click that drops its plan silently
 * downgrades the visitor's intent.
 */
test.describe('landing page', () => {
  test('no link sends a visitor straight to the session-gated onboarding page', async ({ page }) => {
    await page.goto('/');

    const hrefs = await page.locator('a').evaluateAll((links) =>
      links.map((link) => link.getAttribute('href') ?? ''),
    );

    expect(hrefs.length).toBeGreaterThan(0);
    expect(hrefs.filter((href) => href.startsWith('/onboarding'))).toEqual([]);
  });

  test('pricing CTAs carry the chosen plan into login', async ({ page }) => {
    await page.goto('/');

    const hrefs = await page.locator('a').evaluateAll((links) =>
      links.map((link) => link.getAttribute('href') ?? ''),
    );

    expect(hrefs).toContain('/login?plan=starter');
    expect(hrefs).toContain('/login?plan=growth');
  });

  test('the header "Get started" button points at login', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByRole('link', { name: 'Get started' })).toHaveAttribute(
      'href',
      '/login',
    );
  });
});
