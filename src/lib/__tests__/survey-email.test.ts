import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The Resend SDK never throws on a failed send: `fetchRequest` catches network
// faults and turns non-2xx responses into `{ data: null, error }`, then resolves.
// Callers of sendSurveyEmail (the Stripe webhook) branch on a thrown error to
// decide whether to retry and whether to stamp survey_email_sent_at, so this
// mock reproduces the resolve-with-error shape exactly.
const sendMock = vi.fn();
vi.mock('@/lib/resend', () => ({
  getResend: () => ({ emails: { send: (...args: unknown[]) => sendMock(...args) } }),
  FROM_EMAIL: 'digest@churnlens.com',
}));

import { sendSurveyEmail, LegalFooterUnfilledError } from '../survey-email';

const OPTS = {
  to: 'customer@example.com',
  customerName: 'Jane',
  surveyUrl: 'https://app.churnlens.com/survey/tok',
  optOutUrl: 'https://app.churnlens.com/api/survey/opt-out?token=tok',
};

beforeEach(() => {
  sendMock.mockReset();
  sendMock.mockResolvedValue({ data: { id: 'email_1' }, error: null });
});

afterEach(() => {
  // vitest runs the suite with NODE_ENV=test; only the guard tests below
  // deliberately flip it to production via vi.stubEnv, and this undoes that
  // so it never leaks into another test file that imports legal.ts / env.ts.
  // (NODE_ENV is typed readonly by Next's global.d.ts, so vi.stubEnv is used
  // instead of a direct assignment, which fails to typecheck.)
  vi.unstubAllEnvs();
});

describe('sendSurveyEmail', () => {
  it('resolves when Resend reports success', async () => {
    await expect(sendSurveyEmail(OPTS)).resolves.toBeUndefined();
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a hard bounce / rejected recipient', { name: 'validation_error', message: 'Invalid `to` field.' }],
    ['a rate limit', { name: 'rate_limit_exceeded', message: 'Too many requests.' }],
    [
      'a network fault the SDK swallowed',
      { name: 'application_error', message: 'Unable to fetch data. The request could not be resolved.' },
    ],
  ])('throws when Resend resolves with an error: %s', async (_case, error) => {
    // Without this, the send is recorded as delivered: the webhook's catch never
    // runs, survey_email_sent_at is stamped, and the customer never gets a link
    // while nothing in the system says so.
    sendMock.mockResolvedValue({ data: null, error });

    await expect(sendSurveyEmail(OPTS)).rejects.toThrow(/Resend send failed/);
  });

  it('names the Resend error in the message so the log identifies the cause', async () => {
    sendMock.mockResolvedValue({
      data: null,
      error: { name: 'validation_error', message: 'Invalid `to` field.' },
    });

    await expect(sendSurveyEmail(OPTS)).rejects.toThrow(/validation_error/);
    await expect(sendSurveyEmail(OPTS)).rejects.toThrow(/Invalid `to` field\./);
  });

  it('still propagates a genuinely thrown error (e.g. RESEND_API_KEY unset)', async () => {
    sendMock.mockRejectedValue(new Error('boom'));

    await expect(sendSurveyEmail(OPTS)).rejects.toThrow('boom');
  });

  // ── Footer contents ───────────────────────────────────────────────────────

  describe('footer', () => {
    async function sentText(): Promise<string> {
      await sendSurveyEmail(OPTS);
      return sendMock.mock.calls[0][0].text as string;
    }

    it('names the business the customer cancelled with when a display name is set', async () => {
      await sendSurveyEmail({ ...OPTS, displayName: 'Acme Billing' });
      const text = sendMock.mock.calls[0][0].text as string;
      expect(text).toContain('Sent on behalf of Acme Billing by ChurnLens.');
    });

    it('falls back to generic wording with no display name', async () => {
      const text = await sentText();
      expect(text).toContain('Sent on behalf of the business you cancelled with by ChurnLens.');
    });

    it('includes the CAN-SPAM postal address line', async () => {
      const { LEGAL } = await import('../legal');
      const text = await sentText();
      expect(text).toContain(`${LEGAL.entity}, ${LEGAL.postalAddress}`);
    });

    it('includes the unsubscribe link', async () => {
      const text = await sentText();
      expect(text).toContain(OPTS.optOutUrl);
    });

    it('includes a link to the privacy policy', async () => {
      const { LEGAL } = await import('../legal');
      const text = await sentText();
      expect(text).toContain(`Privacy: ${LEGAL.siteUrl}/legal/privacy`);
    });

    it('sets the List-Unsubscribe header to the opt-out URL', async () => {
      await sendSurveyEmail(OPTS);
      const headers = sendMock.mock.calls[0][0].headers as Record<string, string>;
      expect(headers['List-Unsubscribe']).toBe(`<${OPTS.optOutUrl}>`);
    });

    it('sets List-Unsubscribe-Post so providers can one-click POST instead of opening a browser', async () => {
      await sendSurveyEmail(OPTS);
      const headers = sendMock.mock.calls[0][0].headers as Record<string, string>;
      expect(headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    });
  });

  // ── Production guard ──────────────────────────────────────────────────────
  // legal.ts's placeholders are unfilled in every test run (NODE_ENV=test), so
  // the guard is only exercised by explicitly flipping NODE_ENV inside the test.

  describe('production guard', () => {
    function setProduction() {
      vi.stubEnv('NODE_ENV', 'production');
    }

    it('throws LegalFooterUnfilledError in production when legal.ts is unfilled', async () => {
      setProduction();

      await expect(sendSurveyEmail(OPTS)).rejects.toBeInstanceOf(LegalFooterUnfilledError);
      expect(sendMock).not.toHaveBeenCalled();
    });

    it('does not throw outside production even though legal.ts is unfilled', async () => {
      // NODE_ENV is 'test' here (vitest's default) — the guard must not fire.
      await expect(sendSurveyEmail(OPTS)).resolves.toBeUndefined();
      expect(sendMock).toHaveBeenCalledTimes(1);
    });
  });
});
