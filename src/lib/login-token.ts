import { queryOne } from '@/lib/db';
import { hashLoginToken } from '@/lib/crypto';

/**
 * The two reads of a magic-link token, kept side by side so they cannot
 * disagree about what "still usable" means: issued (we only ever store its
 * hash), not used yet, not expired. The confirm page (/login/confirm) asks
 * whether a link is usable without spending it; the confirm POST to
 * /api/auth/verify is the one place that spends it.
 *
 * Both take the raw token from the link and look it up by its SHA-256, so the
 * value that signs someone in never reaches the database or its logs.
 */

/**
 * The address a still-usable link was sent to, or null. Uses nothing up.
 *
 * Shown on the confirm page so the person holding the link can see whose
 * account they are about to enter — the defense against being walked into an
 * attacker's account with the attacker's own link. Null for an unknown, used
 * or expired token alike, so the page reveals nothing the link holder could
 * not already read in the email the link came in.
 */
export async function findUsableLoginToken(rawToken: string): Promise<{ email: string } | null> {
  return queryOne<{ email: string }>(
    `SELECT email FROM login_tokens
     WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()`,
    [hashLoginToken(rawToken)],
  );
}

/**
 * Spend a still-usable link: marks it used and returns the org it signs in to
 * and the destination /api/auth/request stored for it (unvalidated — callers
 * re-check it). Null if the token is unknown, used or expired.
 *
 * Single use is enforced by the UPDATE's own WHERE clause rather than a
 * read-then-write, so two simultaneous confirmations (a double-click, or a
 * replay racing the founder) cannot both get a row back.
 */
export async function consumeLoginToken(
  rawToken: string,
): Promise<{ orgId: string; redirectTo: string | null } | null> {
  const row = await queryOne<{ org_id: string; redirect_to: string | null }>(
    `UPDATE login_tokens SET used_at = now()
     WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
     RETURNING org_id, redirect_to`,
    [hashLoginToken(rawToken)],
  );
  return row ? { orgId: row.org_id, redirectTo: row.redirect_to } : null;
}
