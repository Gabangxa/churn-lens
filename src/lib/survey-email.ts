import { getResend, FROM_EMAIL } from '@/lib/resend';
import { LEGAL, legalFooterReady } from '@/lib/legal';

/**
 * Thrown by sendSurveyEmail in production when the CAN-SPAM footer would go
 * out with a bracketed placeholder still in it (LEGAL.entity or
 * LEGAL.postalAddress unset). Thrown before Resend is ever called — an email
 * that read "[LEGAL ENTITY NAME], [FULL POSTAL ADDRESS]" to a real churned
 * customer is worse than not sending it at all. Exported so callers (the
 * Stripe webhook) can distinguish this from a genuine delivery failure and
 * respond without triggering Stripe's retry storm.
 */
export class LegalFooterUnfilledError extends Error {
  constructor() {
    super(
      'Refusing to send the survey email: src/lib/legal.ts still has an unfilled ' +
        'placeholder in LEGAL.entity or LEGAL.postalAddress, both required in the ' +
        'CAN-SPAM footer.',
    );
    this.name = 'LegalFooterUnfilledError';
  }
}

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
  const onBehalfOf = displayName ?? 'the business you cancelled with';

  // Gated on production only, and only on the two fields the footer actually
  // uses — see legalFooterReady(). Dev and test environments (and any
  // deployment that hasn't gone to production yet) send with the placeholder
  // text so the footer's shape is still visible without blocking on it.
  if (process.env.NODE_ENV === 'production' && !legalFooterReady()) {
    throw new LegalFooterUnfilledError();
  }

  // The Resend SDK resolves with `{ data: null, error }` on failure — it does
  // NOT throw, for HTTP errors or for network faults. Callers here decide what
  // to do based on a thrown error (the webhook retries; the row stays
  // unstamped), so an unchecked return value would record every hard bounce as
  // a successful delivery.
  const { error } = await getResend().emails.send({
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
Sent on behalf of ${onBehalfOf} by ChurnLens.
${LEGAL.entity}, ${LEGAL.postalAddress}
You received this because you had an active subscription. Unsubscribe from exit surveys: ${optOutUrl}
Privacy: ${LEGAL.siteUrl}/legal/privacy
`,
    // CAN-SPAM's one-click unsubscribe (and most mailbox providers' spam
    // filtering) expects this header, not just a link in the body text.
    headers: {
      'List-Unsubscribe': `<${optOutUrl}>`,
    },
  });

  if (error) {
    throw new Error(`Resend send failed: ${error.name}: ${error.message}`);
  }
}
