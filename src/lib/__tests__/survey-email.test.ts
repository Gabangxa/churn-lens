import { describe, it, expect, vi, beforeEach } from 'vitest';

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

import { sendSurveyEmail } from '../survey-email';

const OPTS = {
  to: 'customer@example.com',
  customerName: 'Jane',
  surveyUrl: 'https://app.churnlens.com/survey/tok',
  optOutUrl: 'https://app.churnlens.com/api/survey/opt-out?token=tok',
};

beforeEach(() => {
  sendMock.mockReset();
});

describe('sendSurveyEmail', () => {
  it('resolves when Resend reports success', async () => {
    sendMock.mockResolvedValue({ data: { id: 'email_1' }, error: null });

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
});
