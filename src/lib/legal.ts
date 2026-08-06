/**
 * Single source of truth for the legal documents at /legal/*.
 *
 * Every value wrapped in [SQUARE BRACKETS] is an unfilled placeholder. Fill them
 * in here and all three documents update together. `hasUnfilledPlaceholders()`
 * drives a visible DRAFT banner so a document with placeholders left in it can't
 * quietly look published.
 *
 * NOTE ON RETENTION: `SURVEY_RESPONSE_RETENTION` describes a commitment that is
 * NOT yet implemented — nothing in the codebase deletes survey_responses. Do not
 * publish these documents until a purge job and an account-deletion endpoint
 * exist, or the retention and erasure sections are false on their face.
 */

export const LEGAL = {
  /** Registered legal name, e.g. "ChurnLens Ltd". Not the product name. */
  entity: '[LEGAL ENTITY NAME]',
  /** e.g. "a private limited company registered in England and Wales (no. 12345678)" */
  entityDescription: '[ENTITY TYPE AND REGISTRATION NUMBER]',
  /** Required in every survey email footer under CAN-SPAM. Street address, PO box, or CMRA. */
  postalAddress: '[FULL POSTAL ADDRESS]',
  /** Drives governing law and which privacy regime applies. */
  jurisdiction: '[COUNTRY / STATE]',
  /** Courts with exclusive jurisdiction, e.g. "the courts of England and Wales". */
  courts: '[COURTS]',

  privacyEmail: 'privacy@churnlens.com',
  supportEmail: 'hello@churnlens.com',
  siteUrl: 'https://churnlens.com',

  /** Bump when a document changes materially; shown on every page. */
  lastUpdated: '[EFFECTIVE DATE]',

  /** Intended retention for churned-customer survey data. NOT YET IMPLEMENTED. */
  surveyResponseRetention: '[RETENTION PERIOD, e.g. 24 months]',
  /** Grace period between account deletion request and irreversible purge. */
  deletionWindow: '30 days',
} as const;

/** Named third parties that receive personal data. Disclosed in the policy and DPA. */
export const SUB_PROCESSORS = [
  {
    name: 'Railway',
    purpose: 'Application hosting and PostgreSQL database',
    data: 'All data stored by the Service',
    region: 'United States',
    url: 'https://railway.com/legal/dpa',
  },
  {
    name: 'Resend',
    purpose: 'Transactional email delivery',
    data: 'Recipient email addresses and names, email content',
    region: 'United States',
    url: 'https://resend.com/legal/dpa',
  },
  {
    name: 'OpenAI',
    purpose: 'Clustering free-text survey answers into themes (GPT-4o-mini)',
    data: 'Free-text survey answers and the selected cancellation reason',
    region: 'United States',
    url: 'https://openai.com/policies/data-processing-addendum/',
  },
] as const;

/**
 * True when any placeholder is still unfilled. Used to show the DRAFT banner.
 * Checks for the bracket convention rather than a hand-maintained list.
 */
export function hasUnfilledPlaceholders(): boolean {
  return Object.values(LEGAL).some((v) => typeof v === 'string' && v.includes('['));
}
