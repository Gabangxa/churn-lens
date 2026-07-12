import { getResend, FROM_EMAIL } from '@/lib/resend';

/**
 * The exit-survey email, shared by the Stripe webhook (real cancellations)
 * and the Settings test-survey button so the two can never drift apart.
 */
export async function sendSurveyEmail(opts: {
  to: string;
  customerName: string | null;
  surveyUrl: string;
  optOutUrl: string;
  isTest?: boolean;
  /**
   * Org's configured product/company display name (CL-1). When set, replaces
   * the generic "the founder" / "The team" copy. When unset (undefined or
   * null — the zero-config default), the email is byte-identical to before
   * this feature existed.
   */
  displayName?: string | null;
}): Promise<void> {
  const { to, customerName, surveyUrl, optOutUrl, isTest, displayName } = opts;
  const founderCopy = displayName ? `the ${displayName} team` : 'the founder';
  const signOff = displayName ? `The ${displayName} team` : 'The team';

  await getResend().emails.send({
    from: FROM_EMAIL,
    to,
    subject: `${isTest ? '[Test] ' : ''}Quick question before you go`,
    text: `Hi${customerName ? ` ${customerName}` : ''},

We noticed you cancelled your subscription. We completely understand — no hard feelings.

One quick question: what was the main reason?

→ ${surveyUrl}

It takes two minutes and goes directly to ${founderCopy} (not a support queue). Your answer genuinely shapes what gets built next.

Thanks,
${signOff}

---
You received this because you had an active subscription. Unsubscribe from exit surveys: ${optOutUrl}
`,
  });
}
