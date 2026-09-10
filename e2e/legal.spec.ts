import { expect, test } from '@playwright/test';
// Pure module (no next/, no db) — safe to import into a Playwright process.
import { hasUnfilledPlaceholders } from '../src/lib/legal';

/**
 * The legal pages are a launch blocker, and their failure mode is silence:
 * a document that renders fine while its placeholders are unfilled, or a
 * privacy policy that quietly loses the POPIA-specific sections that make it
 * correct for a South African operator. These assert the parts a reader (or a
 * regulator) would look for.
 */
test.describe('legal pages', () => {
  const DRAFT_BANNER = 'still contains unfilled placeholders';

  for (const path of ['/legal/privacy', '/legal/terms', '/legal/dpa']) {
    test(`${path} renders, and its banner matches legal.ts`, async ({ page }) => {
      const response = await page.goto(path);
      expect(response?.status()).toBe(200);

      // Asserted against src/lib/legal.ts rather than hard-coded, so filling
      // the placeholders in (the actual launch task) makes the banner
      // disappear here too instead of turning the suite red. Note the pages
      // are statically rendered: after editing legal.ts, rebuild.
      if (hasUnfilledPlaceholders()) {
        await expect(page.getByText(DRAFT_BANNER)).toBeVisible();
      } else {
        await expect(page.getByText(DRAFT_BANNER)).toHaveCount(0);
      }
    });
  }

  test('the privacy policy is POPIA-specific', async ({ page }) => {
    await page.goto('/legal/privacy');

    const body = await page.locator('body').innerText();
    expect(body).toContain('POPIA');
    expect(body).toContain('Information Regulator');
  });

  test('the DPA cites the POPIA section it exists to satisfy', async ({ page }) => {
    await page.goto('/legal/dpa');

    expect(await page.locator('body').innerText()).toContain('section 21');
  });

  test('the unsubscribe confirmation links to the privacy policy', async ({ page }) => {
    await page.goto('/survey/unsubscribed');

    await expect(page.getByRole('link', { name: /privacy/i }).first()).toHaveAttribute(
      'href',
      '/legal/privacy',
    );
  });
});
