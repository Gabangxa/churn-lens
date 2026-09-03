import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * The other half of the production guard.
 *
 * survey-email.test.ts covers the refusal (NODE_ENV=production with legal.ts's
 * placeholders still bracketed). This file covers the case that has to keep
 * working once someone fills them in — a guard that never lets a real send
 * through would be just as broken, and nothing else in the suite would notice,
 * because every other test runs with the placeholders unfilled.
 *
 * Separate file because @/lib/legal has to be mocked at module load, and the
 * sibling file deliberately exercises the real (unfilled) one.
 */

const sendMock = vi.fn();
vi.mock('@/lib/resend', () => ({
  getResend: () => ({ emails: { send: sendMock } }),
  FROM_EMAIL: 'digest@churnlens.com',
}));

// vi.mock's factory is hoisted above ordinary top-level declarations, so the
// constants it closes over have to come from vi.hoisted.
const { FILLED } = vi.hoisted(() => ({
  FILLED: {
    entity: 'ChurnLens (Pty) Ltd',
    postalAddress: '12 Loop Street, Cape Town, 8001, South Africa',
    siteUrl: 'https://churnlens.com',
    // Left bracketed on purpose: legalFooterReady() is narrower than
    // hasUnfilledPlaceholders() — a jurisdiction that is still a placeholder
    // shows the /legal DRAFT banner but must not block a survey email, because
    // it never appears in one.
    jurisdiction: '[COUNTRY / STATE]',
  },
}));

vi.mock('@/lib/legal', () => ({
  LEGAL: FILLED,
  legalFooterReady: () => !FILLED.entity.includes('[') && !FILLED.postalAddress.includes('['),
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
  sendMock.mockResolvedValue({ data: { id: 'email_1' }, error: null });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('sendSurveyEmail with the legal footer filled in', () => {
  it('sends in production instead of refusing', async () => {
    vi.stubEnv('NODE_ENV', 'production');

    await expect(sendSurveyEmail(OPTS)).resolves.toBeUndefined();
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('puts the real entity and postal address in the footer', async () => {
    vi.stubEnv('NODE_ENV', 'production');

    await sendSurveyEmail(OPTS);
    const text = sendMock.mock.calls[0][0].text as string;

    expect(text).toContain(`${FILLED.entity}, ${FILLED.postalAddress}`);
    // CAN-SPAM: the physical address has to actually reach the recipient, so no
    // bracketed placeholder may survive anywhere in the body.
    expect(text).not.toMatch(/\[[A-Z /]+\]/);
  });

  it('still carries the unsubscribe link and the List-Unsubscribe header', async () => {
    vi.stubEnv('NODE_ENV', 'production');

    await sendSurveyEmail(OPTS);
    const sent = sendMock.mock.calls[0][0];

    expect(sent.text as string).toContain(`Unsubscribe from exit surveys: ${OPTS.optOutUrl}`);
    expect((sent.headers as Record<string, string>)['List-Unsubscribe']).toBe(
      `<${OPTS.optOutUrl}>`,
    );
  });

  it('names the sender on whose behalf the email goes out', async () => {
    vi.stubEnv('NODE_ENV', 'production');

    await sendSurveyEmail({ ...OPTS, displayName: 'Acme Billing' });
    const text = sendMock.mock.calls[0][0].text as string;

    expect(text).toContain('Sent on behalf of Acme Billing by ChurnLens.');
    expect(text).toContain(`Privacy: ${FILLED.siteUrl}/legal/privacy`);
  });

  it('is unaffected by a jurisdiction placeholder that never reaches the footer', async () => {
    vi.stubEnv('NODE_ENV', 'production');

    await expect(sendSurveyEmail(OPTS)).resolves.toBeUndefined();
  });
});
