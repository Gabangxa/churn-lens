import type { PoolClient } from 'pg';
import { currentLegalDocsVersion } from '@/lib/legal-version';

/** Where an acceptance came from; legal_acceptances.source enforces the same list. */
export type LegalAcceptanceSource = 'connect' | 'banner';

/**
 * What runs the statement: the client withTransaction lends (so the caller's
 * other writes commit or roll back with it), or a Pool.
 */
export type SqlExecutor = Pick<PoolClient, 'query'>;

export interface RecordedLegalAcceptance {
  version: string;
  acceptedAt: Date;
}

/**
 * Records that an org accepted the current Terms of Service and Data
 * Processing Agreement — currentLegalDocsVersion(), never a version the caller
 * passes, so nothing can be recorded against wording that is not live. The
 * caller has already checked that the founder was shown that version.
 *
 * One statement, two writes:
 *  - legal_acceptances gets a row for (org, version) unless one exists. Rows
 *    are never updated, so accepting a new version leaves the record of the
 *    old one — the wording that covered processing until now — intact.
 *  - organizations.legal_accepted_* is the cache of the current acceptance.
 *    Re-accepting the version already there keeps its original time: a second
 *    tab, a double click or a new Stripe key is not a new agreement to the same
 *    wording. In a SET clause the right-hand columns are the row's values
 *    BEFORE the update, and organizations_legal_acceptance_pair_check
 *    guarantees a matching version has a time beside it.
 * A new history row takes its time from the cache row the same statement
 * just wrote, so the two agree about the current acceptance; both are the
 * database's clock, never a client's.
 *
 * Being one statement, it is atomic on its own and also joins whatever
 * transaction the executor is in: the connect route runs it in the same
 * transaction as storing the Stripe key, so a key never lands without its
 * acceptance, nor an acceptance for a key that failed to save.
 *
 * Returns null, having written nothing, when the org row does not exist.
 */
export async function recordLegalAcceptance(
  executor: SqlExecutor,
  orgId: string,
  source: LegalAcceptanceSource,
): Promise<RecordedLegalAcceptance | null> {
  const { rows } = await executor.query<{ version: string; accepted_at: Date }>(
    `WITH current_acceptance AS (
       UPDATE organizations
       SET legal_accepted_at = CASE WHEN legal_accepted_version = $2 THEN legal_accepted_at ELSE now() END,
           legal_accepted_version = $2
       WHERE id = $1
       RETURNING id, legal_accepted_version, legal_accepted_at
     ), history AS (
       INSERT INTO legal_acceptances (org_id, version, accepted_at, source)
       SELECT id, legal_accepted_version, legal_accepted_at, $3 FROM current_acceptance
       ON CONFLICT (org_id, version) DO NOTHING
     )
     SELECT legal_accepted_version AS version, legal_accepted_at AS accepted_at
     FROM current_acceptance`,
    [orgId, currentLegalDocsVersion(), source],
  );
  if (rows.length === 0) return null;
  return { version: rows[0].version, acceptedAt: rows[0].accepted_at };
}
