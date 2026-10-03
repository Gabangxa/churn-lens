import { describe, it, expect } from 'vitest';
import { surveySendStatus } from '../survey-status';

const ready = {
  stripeConnected: true,
  stripeWebhookRegistered: true,
  deletionRequested: false,
  stripeKeyInvalidSince: null,
  legalFooterReady: true,
  plan: 'free',
  surveysThisMonth: 0,
  now: new Date(2026, 8, 28, 15, 0),
};

describe('surveySendStatus', () => {
  it('reports sending when nothing blocks the webhook', () => {
    expect(surveySendStatus(ready)).toEqual({ kind: 'sending' });
  });

  it('reports a missing Stripe connection ahead of every other reason', () => {
    expect(
      surveySendStatus({ ...ready, stripeConnected: false, deletionRequested: true, legalFooterReady: false }),
    ).toEqual({ kind: 'stripe_not_connected' });
  });

  describe('a key stored with no webhook endpoint beside it', () => {
    // Nothing can deliver a cancellation to an org without an endpoint (the
    // webhook answers 404 for it), so it must never read as sending. Left
    // behind by a first connect whose registration failed, before connect
    // stopped storing the key on its own.

    it('tells the founder to finish connecting instead of reporting sending', () => {
      expect(surveySendStatus({ ...ready, stripeWebhookRegistered: false })).toEqual({ kind: 'setup_incomplete' });
    });

    it('ranks just below a missing connection, ahead of everything else', () => {
      expect(
        surveySendStatus({ ...ready, stripeConnected: false, stripeWebhookRegistered: false }),
      ).toEqual({ kind: 'stripe_not_connected' });
      expect(
        surveySendStatus({
          ...ready,
          stripeWebhookRegistered: false,
          deletionRequested: true,
          stripeKeyInvalidSince: new Date(2026, 8, 20),
          legalFooterReady: false,
          surveysThisMonth: 10,
        }),
      ).toEqual({ kind: 'setup_incomplete' });
    });
  });

  it('reports a pending deletion ahead of the legal pause and the free-tier cap', () => {
    expect(
      surveySendStatus({ ...ready, deletionRequested: true, legalFooterReady: false, surveysThisMonth: 10 }),
    ).toEqual({ kind: 'deletion_pending' });
  });

  describe('a Stripe key the webhook found rejected', () => {
    const rejectedOn = new Date(2026, 8, 20, 9, 30);

    it('tells the founder to reconnect, with the date Stripe first rejected it', () => {
      expect(surveySendStatus({ ...ready, stripeKeyInvalidSince: rejectedOn })).toEqual({
        kind: 'stripe_key_invalid',
        since: rejectedOn,
      });
    });

    it('is reported ahead of the legal pause, whose copy says nothing in their setup needs fixing', () => {
      expect(
        surveySendStatus({ ...ready, stripeKeyInvalidSince: rejectedOn, legalFooterReady: false }),
      ).toMatchObject({ kind: 'stripe_key_invalid' });
    });

    it('is reported ahead of the free-tier cap, which lifts on the 1st while the key stays broken', () => {
      expect(
        surveySendStatus({ ...ready, stripeKeyInvalidSince: rejectedOn, surveysThisMonth: 10 }),
      ).toMatchObject({ kind: 'stripe_key_invalid' });
    });

    it('gives way to a missing connection and to a pending deletion', () => {
      // After a disconnect the stale flag is moot; during deletion nothing will send anyway.
      expect(
        surveySendStatus({ ...ready, stripeKeyInvalidSince: rejectedOn, stripeConnected: false }),
      ).toEqual({ kind: 'stripe_not_connected' });
      expect(
        surveySendStatus({ ...ready, stripeKeyInvalidSince: rejectedOn, deletionRequested: true }),
      ).toEqual({ kind: 'deletion_pending' });
    });
  });

  it('reports the platform-side pause while the legal footer is unfilled', () => {
    expect(surveySendStatus({ ...ready, legalFooterReady: false })).toEqual({ kind: 'paused_by_churnlens' });
  });

  it('reports the free-tier cap once 10 surveys went out this month, resetting on the 1st', () => {
    const status = surveySendStatus({ ...ready, surveysThisMonth: 10 });
    expect(status).toEqual({ kind: 'free_tier_limit', limit: 10, resetsOn: new Date(2026, 9, 1) });
  });

  it('rolls the reset date into January when the cap is hit in December', () => {
    const status = surveySendStatus({ ...ready, surveysThisMonth: 12, now: new Date(2026, 11, 31, 23, 0) });
    expect(status).toMatchObject({ kind: 'free_tier_limit', resetsOn: new Date(2027, 0, 1) });
  });

  it('keeps a free org under the cap sending', () => {
    expect(surveySendStatus({ ...ready, surveysThisMonth: 9 })).toEqual({ kind: 'sending' });
  });

  it('never applies the cap to a paid plan', () => {
    expect(surveySendStatus({ ...ready, plan: 'starter', surveysThisMonth: 500 })).toEqual({ kind: 'sending' });
  });
});
