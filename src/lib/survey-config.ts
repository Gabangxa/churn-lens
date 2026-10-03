/**
 * Light survey customization (CL-1): per-org display name, logo URL, and
 * extra cancellation reasons, stored as JSONB on `organizations.survey_config`.
 *
 * Two entry points, deliberately different in strictness:
 *  - `loadSurveyConfig` — read path (survey page, email callers). Defensive:
 *    never throws, silently falls back to defaults on missing/malformed data
 *    (including hand-edited DB rows) so a bad row can never break survey render.
 *  - `validateSurveyConfig` — write path (PUT /api/settings/survey-config).
 *    Authoritative: rejects invalid input with a field-level error instead of
 *    silently truncating or dropping it. Nothing is persisted on failure.
 *
 * Zero-config invariant: NULL column, `{}`, or all-empty values normalize to
 * `{ displayName: null, logoUrl: null, customReasons: [] }` — today's behavior.
 */
import { queryOne } from '@/lib/db';
import { reportError } from '@/lib/report-error';

// Single source of truth for the built-in reasons, shared with the survey
// page so rendering and validation (dedupe-against-built-ins) can never drift.
export const BUILTIN_CANCELLATION_REASONS = [
  'Too expensive for my budget',
  'Missing a feature I need',
  'Switched to a competitor',
  'Stopped needing this type of tool',
  'Product was too difficult to use',
  'Had a bad support experience',
  'Just trying things out — not ready to commit',
  'Other',
] as const;

const BUILTIN_LOWER = new Set(BUILTIN_CANCELLATION_REASONS.map((r) => r.toLowerCase()));

export const SURVEY_CONFIG_LIMITS = {
  displayNameMaxLen: 60,
  logoUrlMaxLen: 300,
  customReasonsMax: 5,
  customReasonMaxLen: 60,
} as const;

export interface SurveyConfig {
  displayName: string | null;
  logoUrl: string | null;
  customReasons: string[];
}

const DEFAULT_CONFIG: SurveyConfig = {
  displayName: null,
  logoUrl: null,
  customReasons: [],
};

// Strips ASCII control characters (C0 + DEL), including newlines/tabs — the
// display name renders inline in a single line of survey/email copy.
function stripControlChars(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\x00-\x1F\x7F]/g, '');
}

// The same character class, for values where removing a character would
// change their meaning (a URL) and which are refused instead.
function hasControlChars(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\x00-\x1F\x7F]/.test(value);
}

/**
 * The URL as the browser will request it (its parsed href), or null when it
 * is not an https URL. Callers refuse control characters first: the parser
 * accepts them, percent-encoding some (NUL becomes %00) and silently dropping
 * others (tab, newline), so the saved value would differ from what was typed.
 */
function httpsHref(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

// Case-insensitive dedupe: drops entries matching a built-in, then drops
// repeats within the remaining list (first occurrence wins), preserving order.
function dedupeAgainstBuiltinsAndSelf(reasons: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const reason of reasons) {
    const key = reason.toLowerCase();
    if (BUILTIN_LOWER.has(key)) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(reason);
  }
  return result;
}

/**
 * A business name as it may appear in survey copy ("the Acme team", "Sent on
 * behalf of Acme"), or null when there is none fit to print. Control
 * characters — line breaks included — are stripped, so a name can only ever
 * occupy its own place in one line of the plain-text email. Empty or
 * over-limit values read as absent (the generic copy) rather than being cut
 * off mid-word. One rule for the configured display name and for the Stripe
 * account's name, which is just as untrusted.
 */
export function normalizeBusinessName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = stripControlChars(raw).trim();
  if (trimmed.length === 0 || trimmed.length > SURVEY_CONFIG_LIMITS.displayNameMaxLen) return null;
  return trimmed;
}

/**
 * Defensive normalizer for whatever is stored in the DB. Never throws — any
 * missing/malformed key falls back to its default rather than erroring the
 * survey render. Also re-applies the length/count limits and dedupe so a
 * hand-edited row can't smuggle an oversized or duplicate value through.
 */
function normalizeStoredConfig(raw: unknown): SurveyConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...DEFAULT_CONFIG, customReasons: [] };
  }
  const obj = raw as Record<string, unknown>;

  const displayName = normalizeBusinessName(obj.display_name);

  // The same rules validateSurveyConfig applies, so a hand-edited row cannot
  // render a URL the write path would have refused.
  let logoUrl: string | null = null;
  if (typeof obj.logo_url === 'string') {
    const trimmed = obj.logo_url.trim();
    const href = hasControlChars(trimmed) ? null : httpsHref(trimmed);
    if (href !== null && href.length <= SURVEY_CONFIG_LIMITS.logoUrlMaxLen) {
      logoUrl = href;
    }
  }

  let customReasons: string[] = [];
  if (Array.isArray(obj.custom_reasons)) {
    const cleaned = obj.custom_reasons
      .filter((r): r is string => typeof r === 'string')
      .map((r) => stripControlChars(r).trim())
      .filter((r) => r.length > 0 && r.length <= SURVEY_CONFIG_LIMITS.customReasonMaxLen);
    customReasons = dedupeAgainstBuiltinsAndSelf(cleaned).slice(0, SURVEY_CONFIG_LIMITS.customReasonsMax);
  }

  return { displayName, logoUrl, customReasons };
}

/**
 * Loads and normalizes an org's survey config by orgId. Never throws: DB
 * errors, missing rows, NULL columns, and malformed JSON all resolve to the
 * zero-config default so callers (survey page render, email send) never crash
 * on a bad config.
 */
export async function loadSurveyConfig(orgId: string): Promise<SurveyConfig> {
  try {
    const row = await queryOne<{ survey_config: unknown }>(
      'SELECT survey_config FROM organizations WHERE id = $1',
      [orgId],
    );
    if (!row) return { ...DEFAULT_CONFIG, customReasons: [] };
    return normalizeStoredConfig(row.survey_config);
  } catch (err) {
    // Callers degrade to the zero-config copy, so nothing visibly breaks —
    // which is why it is reported: surveys silently lose the org's own name,
    // logo and reasons until the database answers again.
    reportError('survey-config.load', err, { orgId });
    return { ...DEFAULT_CONFIG, customReasons: [] };
  }
}

/** The survey config plus the business the survey says is asking. */
export interface SurveyPresentation extends SurveyConfig {
  /**
   * Who the churned customer is told the survey is from — POPIA s18 requires
   * the data subject be told the responsible party's identity. In order: the
   * configured display name; else the connected Stripe account's business
   * name, as cached in organizations.stripe_business_name by
   * /api/onboarding/connect or the Stripe webhook; else null, which keeps
   * today's generic copy (no new required setup — the 2026-07-12 zero-config
   * decision).
   *
   * The survey emails resolve it here at send time and record what they
   * sent in survey_responses.business_name; the survey page shows that
   * record (loadSurveyPagePresentation), so the page names the business the
   * email named even if the org's name changed in between.
   */
  businessName: string | null;
}

/** The config and resolved name for one organizations row. */
function presentationFromRow(row: { survey_config: unknown; stripe_business_name: unknown }): SurveyPresentation {
  const config = normalizeStoredConfig(row.survey_config);
  return {
    ...config,
    // Normalized again on read, like every stored config field, so a
    // hand-edited row cannot put a line break into the email.
    businessName: config.displayName ?? normalizeBusinessName(row.stripe_business_name),
  };
}

/**
 * loadSurveyConfig plus the resolved businessName, in one read: the org's
 * name as it is now, for the survey emails. Never throws, with the same
 * fall-back-to-defaults contract as loadSurveyConfig.
 */
export async function loadSurveyPresentation(orgId: string): Promise<SurveyPresentation> {
  try {
    const row = await queryOne<{ survey_config: unknown; stripe_business_name: unknown }>(
      'SELECT survey_config, stripe_business_name FROM organizations WHERE id = $1',
      [orgId],
    );
    if (!row) return { ...DEFAULT_CONFIG, customReasons: [], businessName: null };
    return presentationFromRow(row);
  } catch (err) {
    // As loadSurveyConfig: degraded rather than failed, so reported — here the
    // survey also stops naming the business that is asking (POPIA s18).
    reportError('survey-config.load', err, { orgId });
    return { ...DEFAULT_CONFIG, customReasons: [], businessName: null };
  }
}

/**
 * The presentation for the survey page a link opens, in one read: the org's
 * config, with businessName taken from what the email for this token said
 * (survey_responses.business_name) when that was recorded. Re-resolved when
 * the page is opened, the name could differ from the email's — after a
 * rename, a reconnect to another Stripe account, or a disconnect. Without a
 * record (a row sent before names were recorded, an email that used the
 * generic copy, a preview link with no row) it is the org's current name, as
 * loadSurveyPresentation resolves it. Scoped to orgId as well as the token,
 * so no other org's record can be shown. Never throws.
 */
export async function loadSurveyPagePresentation(orgId: string, token: string): Promise<SurveyPresentation> {
  try {
    const row = await queryOne<{ survey_config: unknown; stripe_business_name: unknown; sent_business_name: unknown }>(
      `SELECT o.survey_config, o.stripe_business_name, r.business_name AS sent_business_name
       FROM organizations o
       LEFT JOIN survey_responses r ON r.token = $2 AND r.org_id = o.id
       WHERE o.id = $1`,
      [orgId, token],
    );
    if (!row) return { ...DEFAULT_CONFIG, customReasons: [], businessName: null };
    const current = presentationFromRow(row);
    return { ...current, businessName: normalizeBusinessName(row.sent_business_name) ?? current.businessName };
  } catch (err) {
    reportError('survey-config.load', err, { orgId });
    return { ...DEFAULT_CONFIG, customReasons: [], businessName: null };
  }
}

export interface SurveyConfigValidationError {
  ok: false;
  error: string;
  field: 'displayName' | 'logoUrl' | 'customReasons';
}

export interface SurveyConfigValidationSuccess {
  ok: true;
  value: SurveyConfig;
}

export type SurveyConfigValidationResult = SurveyConfigValidationSuccess | SurveyConfigValidationError;

/**
 * Authoritative validator for the PUT /api/settings/survey-config body.
 * Rejects (rather than silently truncates) anything over the field limits;
 * only empty/duplicate custom-reason entries are silently dropped, per spec.
 */
export function validateSurveyConfig(input: unknown): SurveyConfigValidationResult {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'Request body must be an object.', field: 'displayName' };
  }
  const obj = input as Record<string, unknown>;

  // --- displayName ---
  let displayName: string | null = null;
  const rawDisplayName = obj.displayName;
  if (rawDisplayName !== undefined && rawDisplayName !== null) {
    if (typeof rawDisplayName !== 'string') {
      return { ok: false, error: 'Display name must be a string.', field: 'displayName' };
    }
    const trimmed = stripControlChars(rawDisplayName).trim();
    if (trimmed.length > SURVEY_CONFIG_LIMITS.displayNameMaxLen) {
      return {
        ok: false,
        error: `Display name must be ${SURVEY_CONFIG_LIMITS.displayNameMaxLen} characters or fewer.`,
        field: 'displayName',
      };
    }
    displayName = trimmed.length > 0 ? trimmed : null;
  }

  // --- logoUrl ---
  let logoUrl: string | null = null;
  const rawLogoUrl = obj.logoUrl;
  if (rawLogoUrl !== undefined && rawLogoUrl !== null) {
    if (typeof rawLogoUrl !== 'string') {
      return { ok: false, error: 'Logo URL must be a string.', field: 'logoUrl' };
    }
    const trimmed = rawLogoUrl.trim();
    if (trimmed.length > 0) {
      const tooLongError = `Logo URL must be ${SURVEY_CONFIG_LIMITS.logoUrlMaxLen} characters or fewer.`;
      if (trimmed.length > SURVEY_CONFIG_LIMITS.logoUrlMaxLen) {
        return { ok: false, error: tooLongError, field: 'logoUrl' };
      }
      // Refused, not stripped: a URL with a character removed is a different
      // URL. And Postgres jsonb cannot store a NUL at all (22P05), so letting
      // one through turned a pasted typo into a failed save and an operator
      // alert instead of this field error.
      if (hasControlChars(trimmed)) {
        return { ok: false, error: 'Logo URL must not contain control characters.', field: 'logoUrl' };
      }
      const href = httpsHref(trimmed);
      if (href === null) {
        return { ok: false, error: 'Logo URL must be a valid https:// URL.', field: 'logoUrl' };
      }
      // Stored as parsed, so it is exactly what the survey page will request.
      // Checked again because parsing can lengthen it (a space becomes %20),
      // and the read path drops anything over the limit.
      if (href.length > SURVEY_CONFIG_LIMITS.logoUrlMaxLen) {
        return { ok: false, error: tooLongError, field: 'logoUrl' };
      }
      logoUrl = href;
    }
  }

  // --- customReasons ---
  let customReasons: string[] = [];
  const rawCustomReasons = obj.customReasons;
  if (rawCustomReasons !== undefined && rawCustomReasons !== null) {
    if (!Array.isArray(rawCustomReasons)) {
      return { ok: false, error: 'Custom reasons must be an array of strings.', field: 'customReasons' };
    }
    if (!rawCustomReasons.every((r) => typeof r === 'string')) {
      return { ok: false, error: 'Custom reasons must be an array of strings.', field: 'customReasons' };
    }
    if (rawCustomReasons.length > SURVEY_CONFIG_LIMITS.customReasonsMax) {
      return {
        ok: false,
        error: `Maximum ${SURVEY_CONFIG_LIMITS.customReasonsMax} custom reasons allowed.`,
        field: 'customReasons',
      };
    }

    const trimmedReasons: string[] = [];
    for (const raw of rawCustomReasons as string[]) {
      const trimmed = stripControlChars(raw).trim();
      if (trimmed.length === 0) continue; // empty/whitespace-only entries dropped
      if (trimmed.length > SURVEY_CONFIG_LIMITS.customReasonMaxLen) {
        return {
          ok: false,
          error: `Each custom reason must be ${SURVEY_CONFIG_LIMITS.customReasonMaxLen} characters or fewer.`,
          field: 'customReasons',
        };
      }
      trimmedReasons.push(trimmed);
    }

    // Duplicates (case-insensitive, vs built-ins and each other) are dropped
    // silently per spec — not a validation error.
    customReasons = dedupeAgainstBuiltinsAndSelf(trimmedReasons);
  }

  return { ok: true, value: { displayName, logoUrl, customReasons } };
}

/** Maps the normalized wire-shape config to the snake_case JSONB storage shape. */
export function toStoredConfig(config: SurveyConfig): Record<string, unknown> {
  return {
    display_name: config.displayName,
    logo_url: config.logoUrl,
    custom_reasons: config.customReasons,
  };
}
