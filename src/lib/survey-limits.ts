/**
 * Length caps for the free-text survey fields.
 *
 * Lives in its own module because two independent boundaries have to agree on
 * the same numbers: the POST /api/survey write path (what we store) and
 * clusterResponses in src/lib/openai.ts (what we pay OpenAI to read). The
 * survey page's `maxLength` attributes mirror these too, but as literals —
 * that file is a server component in the app tree and importing a lib constant
 * there buys nothing over a number the reviewer can see next to the textarea.
 *
 * The DB columns are unbounded `text`, so these caps are the only thing
 * standing between a survey link and an arbitrarily large row.
 */

export const MAX_OPEN_TEXT = 2000;
export const MAX_COMEBACK_TEXT = 2000;

/**
 * Cap on `reason`. Generous next to the longest built-in reason, but it is what
 * bounds the column: `reason` is a grouping key shown on the dashboard and sent
 * to OpenAI, and a survey token is enough to POST an arbitrary value for it.
 */
export const MAX_REASON = 120;

export interface TruncationResult {
  value: string;
  truncated: boolean;
}

/**
 * Truncate free text to `max` characters.
 *
 * WHY truncate instead of rejecting: this is a churned customer's one-shot
 * feedback. They will not come back and re-submit a shorter version — the link
 * is single-use and they have already left. Throwing away a 2,100-character
 * answer to punish verbosity loses the exact signal the product exists to
 * capture; storing the first 2,000 characters loses a tail. Callers are
 * expected to log when `truncated` is true so silent data loss is at least
 * visible in the logs.
 *
 * `reason` is capped by the same helper. It is nominally a closed set, but the
 * set is per-org and editable, so a submission can legitimately carry a reason
 * that no longer exists — see the POST handler for why that is accepted rather
 * than rejected.
 */
export function truncateFreeText(value: string, max: number): TruncationResult {
  if (value.length <= max) return { value, truncated: false };

  let cut = value.slice(0, max);

  // A slice can land between the two halves of a surrogate pair (an emoji at
  // the boundary), leaving a lone high surrogate that has no valid UTF-8
  // encoding — Postgres rejects such a string outright. Drop the orphan.
  const lastCode = cut.charCodeAt(cut.length - 1);
  const isHighSurrogate = lastCode >= 0xd800 && lastCode <= 0xdbff;
  if (isHighSurrogate) {
    cut = cut.slice(0, -1);
  }

  return { value: cut, truncated: true };
}
