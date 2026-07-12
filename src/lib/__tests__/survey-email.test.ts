import { describe, it, expect, vi, beforeEach } from 'vitest';

const sendMock = vi.fn();

vi.mock('../resend', () => ({
  getResend: () => ({ emails: { send: sendMock } }),
  FROM_EMAIL: 'digest@churnlens.com',
}));

import { sendSurveyEmail } from '../survey-email';

beforeEach(() => {
  sendMock.mockReset();
  sendMock.mockResolvedValue({ data: { id: 'email-1' }, error: null });
});

const BASE_OPTS = {
  to: 'customer@example.com',
  customerName: 'Jane',
  surveyUrl: 'https://churnlens.com/survey/tok123',
  optOutUrl: 'https://churnlens.com/opt-out/tok123',
};

// Exact pre-CL-1 template, reproduced here as the regression baseline. If
// this test fails, either the template changed unintentionally, or the
// baseline below needs to be updated deliberately alongside the change.
function expectedText(opts: { customerName: string | null; surveyUrl: string; optOutUrl: string; founderCopy: string; signOff: string }) {
  const { customerName, surveyUrl, optOutUrl, founderCopy, signOff } = opts;
  return `Hi${customerName ? ` ${customerName}` : ''},

We noticed you cancelled your subscription. We completely understand — no hard feelings.

One quick question: what was the main reason?

→ ${surveyUrl}

It takes two minutes and goes directly to ${founderCopy} (not a support queue). Your answer genuinely shapes what gets built next.

Thanks,
${signOff}

---
You received this because you had an active subscription. Unsubscribe from exit surveys: ${optOutUrl}
`;
}

describe('sendSurveyEmail', () => {
  it('without a displayName, is byte-identical to the pre-CL-1 template', async () => {
    await sendSurveyEmail(BASE_OPTS);

    expect(sendMock).toHaveBeenCalledTimes(1);
    const call = sendMock.mock.calls[0][0];
    expect(call.from).toBe('digest@churnlens.com');
    expect(call.to).toBe(BASE_OPTS.to);
    expect(call.subject).toBe('Quick question before you go');
    expect(call.text).toBe(
      expectedText({
        customerName: BASE_OPTS.customerName,
        surveyUrl: BASE_OPTS.surveyUrl,
        optOutUrl: BASE_OPTS.optOutUrl,
        founderCopy: 'the founder',
        signOff: 'The team',
      }),
    );
    expect(call.text).toContain('goes directly to the founder');
    expect(call.text).toContain('Thanks,\nThe team');
  });

  it('displayName null behaves identically to displayName omitted (zero-config default)', async () => {
    await sendSurveyEmail({ ...BASE_OPTS, displayName: null });
    const withNull = sendMock.mock.calls[0][0];

    sendMock.mockClear();
    await sendSurveyEmail(BASE_OPTS);
    const withOmitted = sendMock.mock.calls[0][0];

    expect(withNull).toEqual(withOmitted);
  });

  it('with a displayName set, only the two interpolation points change — nothing else', async () => {
    await sendSurveyEmail({ ...BASE_OPTS, displayName: 'Acme' });
    const call = sendMock.mock.calls[0][0];

    const expected = expectedText({
      customerName: BASE_OPTS.customerName,
      surveyUrl: BASE_OPTS.surveyUrl,
      optOutUrl: BASE_OPTS.optOutUrl,
      founderCopy: 'the Acme team',
      signOff: 'The Acme team',
    });
    expect(call.text).toBe(expected);
    expect(call.subject).toBe('Quick question before you go'); // subject unaffected by displayName
  });

  it('prefixes the subject with [Test] when isTest is set, independent of displayName', async () => {
    await sendSurveyEmail({ ...BASE_OPTS, isTest: true });
    expect(sendMock.mock.calls[0][0].subject).toBe('[Test] Quick question before you go');

    sendMock.mockClear();
    await sendSurveyEmail({ ...BASE_OPTS, isTest: true, displayName: 'Acme' });
    expect(sendMock.mock.calls[0][0].subject).toBe('[Test] Quick question before you go');
  });

  it('omits the greeting name when customerName is null', async () => {
    await sendSurveyEmail({ ...BASE_OPTS, customerName: null });
    const call = sendMock.mock.calls[0][0];
    expect(call.text.startsWith('Hi,\n')).toBe(true);
  });
});
