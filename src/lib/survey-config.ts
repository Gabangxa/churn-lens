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

function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:';
  } catch {
    return false;
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

  let displayName: string | null = null;
  if (typeof obj.display_name === 'string') {
    const trimmed = stripControlChars(obj.display_name).trim();
    if (trimmed.length > 0 && trimmed.length <= SURVEY_CONFIG_LIMITS.displayNameMaxLen) {
      displayName = trimmed;
    }
  }

  let logoUrl: string | null = null;
  if (typeof obj.logo_url === 'string') {
    const trimmed = obj.logo_url.trim();
    if (
      trimmed.length > 0 &&
      trimmed.length <= SURVEY_CONFIG_LIMITS.logoUrlMaxLen &&
      isHttpsUrl(trimmed)
    ) {
      logoUrl = trimmed;
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
    console.error(`Failed to load survey_config for org ${orgId}:`, err);
    return { ...DEFAULT_CONFIG, customReasons: [] };
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
      if (trimmed.length > SURVEY_CONFIG_LIMITS.logoUrlMaxLen) {
        return {
          ok: false,
          error: `Logo URL must be ${SURVEY_CONFIG_LIMITS.logoUrlMaxLen} characters or fewer.`,
          field: 'logoUrl',
        };
      }
      if (!isHttpsUrl(trimmed)) {
        return { ok: false, error: 'Logo URL must be a valid https:// URL.', field: 'logoUrl' };
      }
      logoUrl = trimmed;
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
