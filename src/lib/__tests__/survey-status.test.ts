import { describe, it, expect } from 'vitest';
import { surveySendStatus } from '../survey-status';

const ready = {
  stripeConnected: true,
  deletionRequested: false,
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

  it('reports a pending deletion ahead of the legal pause and the free-tier cap', () => {
    expect(
      surveySendStatus({ ...ready, deletionRequested: true, legalFooterReady: false, surveysThisMonth: 10 }),
    ).toEqual({ kind: 'deletion_pending' });
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
