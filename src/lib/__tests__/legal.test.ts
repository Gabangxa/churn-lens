import { describe, it, expect } from 'vitest';
import { LEGAL, hasUnfilledPlaceholders, legalFooterReady } from '../legal';

/**
 * LEGAL is now load-bearing in two directions at once: the /legal pages publish
 * these values as promises to data subjects, and the purge job's SQL enforces
 * the numeric ones. A drift between the label and the number is a document that
 * lies about what the code does — which is the exact failure this commit set
 * out to close.
 */
describe('LEGAL retention and deletion values', () => {
  it('publishes the same retention the purge job enforces', () => {
    expect(LEGAL.surveyResponseRetention).toBe(`${LEGAL.surveyResponseRetentionMonths} months`);
    expect(LEGAL.surveyResponseRetentionMonths).toBe(24);
  });

  it('publishes the same deletion window the purge job enforces', () => {
    // Unlike the retention label, this one is a hand-written string rather than
    // a derived one — change DELETION_WINDOW_DAYS alone and the privacy policy
    // keeps promising the old window. This is the test that catches that.
    expect(LEGAL.deletionWindow).toBe(`${LEGAL.deletionWindowDays} days`);
    expect(LEGAL.deletionWindowDays).toBe(30);
  });

  it('keeps both windows positive integers', () => {
    // Both are interpolated into `now() - ($1 || ' months'|' days')::interval`.
    // A zero or negative value does not fail loudly — it moves the cutoff into
    // the future and the DELETE takes everything.
    for (const n of [LEGAL.surveyResponseRetentionMonths, LEGAL.deletionWindowDays]) {
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThan(0);
    }
  });
});

describe('placeholder gating', () => {
  it('reports the documents as still unpublishable', () => {
    // Not a preference — this is why the survey email's production guard trips
    // today, and why /legal shows the DRAFT banner. If someone fills the
    // placeholders in, this test is the reminder to check both.
    expect(hasUnfilledPlaceholders()).toBe(true);
  });

  it('reports the CAN-SPAM footer as not ready while entity or address is bracketed', () => {
    expect(legalFooterReady()).toBe(false);
    expect(LEGAL.entity).toContain('[');
    expect(LEGAL.postalAddress).toContain('[');
  });

  it('detects a placeholder by the bracket convention rather than a fixed list', () => {
    const bracketed = Object.entries(LEGAL).filter(
      ([, v]) => typeof v === 'string' && v.includes('['),
    );
    expect(bracketed.length).toBeGreaterThan(0);
    expect(hasUnfilledPlaceholders()).toBe(bracketed.length > 0);
  });
});
