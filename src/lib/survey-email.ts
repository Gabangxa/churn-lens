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
}): Promise<void> {
  const { to, customerName, surveyUrl, optOutUrl, isTest } = opts;

  await getResend().emails.send({
    from: FROM_EMAIL,
    to,
    subject: `${isTest ? '[Test] ' : ''}Quick question before you go`,
    text: `Hi${customerName ? ` ${customerName}` : ''},

We noticed you cancelled your subscription. We completely understand — no hard feelings.

One quick question: what was the main reason?

→ ${surveyUrl}

It takes two minutes and goes directly to the founder (not a support queue). Your answer genuinely shapes what gets built next.

Thanks,
The team

---
You received this because you had an active subscription. Unsubscribe from exit surveys: ${optOutUrl}
`,
  });
}
