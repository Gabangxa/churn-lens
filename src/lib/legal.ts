/**
 * Single source of truth for the legal documents at /legal/*.
 *
 * Every value wrapped in [SQUARE BRACKETS] is an unfilled placeholder. Fill them
 * in here and all three documents update together. `hasUnfilledPlaceholders()`
 * drives a visible DRAFT banner so a document with placeholders left in it can't
 * quietly look published.
 *
 * NOTE ON RETENTION AND DELETION: these are no longer aspirational. The daily
 * purge job (src/app/api/purge) enforces `surveyResponseRetentionMonths` below
 * against survey_responses and themes, and the account-deletion endpoint
 * (src/app/api/settings/account/delete) sets `deletion_requested_at`, which the
 * same job hard-deletes `deletionWindowDays` after. What remains before
 * publishing is filling in the bracketed placeholders below (entity, address,
 * jurisdiction, information officer) and a lawyer's review — not building the
 * mechanism these documents describe.
 */

const SURVEY_RESPONSE_RETENTION_MONTHS = 24;
const DELETION_WINDOW_DAYS = 30;

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

  /**
   * Retention for churned-customer survey data, in months. This is the number
   * the purge job's SQL actually uses (`now() - (N || ' months')::interval`) —
   * change it here, not in the derived label below.
   */
  surveyResponseRetentionMonths: SURVEY_RESPONSE_RETENTION_MONTHS,
  /** Human-readable form of the above, e.g. "24 months". Kept on LEGAL so existing JSX (`LEGAL.surveyResponseRetention`) is unaffected by this split. */
  surveyResponseRetention: `${SURVEY_RESPONSE_RETENTION_MONTHS} months`,
  /** Grace period between account deletion request and irreversible purge. */
  deletionWindow: '30 days',
  /** The above, as a number, for the purge job's SQL. */
  deletionWindowDays: DELETION_WINDOW_DAYS,

  /** POPIA s55/s56 requires a designated Information Officer to be named and registered with the Information Regulator. */
  informationOfficer: '[INFORMATION OFFICER NAME]',
  /** POPIA's supervisory authority — the equivalent of the UK ICO or an EU DPA. */
  regulatorName: 'Information Regulator (South Africa)',
  regulatorUrl: 'https://inforegulator.org.za',
} as const;

/**
 * Named third parties that receive personal data. Disclosed in the policy and DPA.
 *
 * `processesCustomerData` is what keeps the two documents from lying in opposite
 * directions. The privacy policy covers BOTH tiers — the founder's own account
 * data (we are controller) and their churned customers' data (we are processor) —
 * so it lists every entry. The DPA governs only the second tier, so it must list
 * only the entries that actually touch a customer's end-customer data.
 *
 * Polar is the case that forced the distinction: it bills ChurnLens itself and
 * never sees a churned customer's name, email or free text. Listing it in the
 * DPA's table would tell a signing customer that their end customers' data is
 * disclosed to a payment processor, which is false. Omitting it from the privacy
 * policy would be equally false in the other direction — it does process the
 * founder's own name, email and billing details.
 */
export const SUB_PROCESSORS = [
  {
    name: 'Railway',
    purpose: 'Application hosting and PostgreSQL database',
    data: 'All data stored by the Service',
    region: 'United States',
    url: 'https://railway.com/legal/dpa',
    processesCustomerData: true,
  },
  {
    name: 'Resend',
    purpose: 'Transactional email delivery',
    data: 'Recipient email addresses and names, email content',
    region: 'United States',
    url: 'https://resend.com/legal/dpa',
    processesCustomerData: true,
  },
  {
    name: 'OpenAI',
    purpose: 'Clustering free-text survey answers into themes (GPT-4o-mini)',
    data: 'Free-text survey answers and the selected cancellation reason',
    region: 'United States',
    url: 'https://openai.com/policies/data-processing-addendum/',
    processesCustomerData: true,
  },
  {
    name: 'Polar',
    purpose: 'Subscription billing for ChurnLens accounts (merchant of record)',
    data: 'Account holder name, email address and billing details. No survey data.',
    region: 'United States',
    url: 'https://polar.sh/legal/data-processing-addendum',
    processesCustomerData: false,
  },
] as const;

/**
 * The subset disclosed in the DPA — those that process the customer's own
 * end-customer personal data. See the note on SUB_PROCESSORS.
 */
export const DPA_SUB_PROCESSORS = SUB_PROCESSORS.filter((sp) => sp.processesCustomerData);

/**
 * True when any placeholder is still unfilled. Used to show the DRAFT banner.
 * Checks for the bracket convention rather than a hand-maintained list.
 */
export function hasUnfilledPlaceholders(): boolean {
  return Object.values(LEGAL).some((v) => typeof v === 'string' && v.includes('['));
}

/**
 * True once the specific fields CAN-SPAM requires in the survey email footer
 * are filled in. Deliberately narrower than `hasUnfilledPlaceholders()`: a
 * missing `jurisdiction` or `courts` value should show the /legal draft
 * banner, but must not block a real survey email — those fields never appear
 * in it. Only `entity` and `postalAddress` do.
 */
export function legalFooterReady(): boolean {
  return !LEGAL.entity.includes('[') && !LEGAL.postalAddress.includes('[');
}
