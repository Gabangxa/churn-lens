import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ────────────────────────────────────────────────────────────────
// No Postgres, no Stripe API in this environment: every boundary the route
// touches is stubbed. `query` and `execute` are multiplexed on SQL text since
// the route issues several different statements through each helper.

const queryMock = vi.fn();
const executeMock = vi.fn();
vi.mock('@/lib/db', () => ({
  query: (...args: unknown[]) => queryMock(...args),
  execute: (...args: unknown[]) => executeMock(...args),
}));

const verifyCronSecretMock = vi.fn();
vi.mock('@/lib/auth', () => ({
  verifyCronSecret: (...args: unknown[]) => verifyCronSecretMock(...args),
}));

const claimCronRunMock = vi.fn();
const finishCronRunMock = vi.fn();
vi.mock('@/lib/cron', () => ({
  claimCronRun: (...args: unknown[]) => claimCronRunMock(...args),
  finishCronRun: (...args: unknown[]) => finishCronRunMock(...args),
  todayDateStr: () => DATE_STR,
}));

const disconnectStripeMock = vi.fn();
vi.mock('@/lib/stripe-disconnect', () => ({
  disconnectStripe: (...args: unknown[]) => disconnectStripeMock(...args),
}));

const DATE_STR = '2026-09-01';

import { POST } from '../route';
import { LEGAL } from '@/lib/legal';

function purgeRequest() {
  return new Request('http://localhost/api/purge', {
    method: 'POST',
    headers: { authorization: 'Bearer secret' },
  });
}

beforeEach(() => {
  queryMock.mockReset();
  executeMock.mockReset();
  verifyCronSecretMock.mockReset();
  claimCronRunMock.mockReset();
  finishCronRunMock.mockReset();
  disconnectStripeMock.mockReset();

  verifyCronSecretMock.mockReturnValue(true);
  claimCronRunMock.mockResolvedValue(true);
  finishCronRunMock.mockResolvedValue(undefined);
  disconnectStripeMock.mockResolvedValue(undefined);

  // Happy path: no rows deleted/found anywhere, nothing fails.
  executeMock.mockResolvedValue(0);
  queryMock.mockResolvedValue([]);

  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('POST /api/purge', () => {
  it('returns 401 when unauthorized', async () => {
    verifyCronSecretMock.mockReturnValue(false);
    const res = await POST(purgeRequest());
    expect(res.status).toBe(401);
    expect(claimCronRunMock).not.toHaveBeenCalled();
  });

  it('returns already_ran when the claim is lost, without running any step', async () => {
    claimCronRunMock.mockResolvedValue(false);

    const res = await POST(purgeRequest());
    const body = await res.json();

    expect(body).toEqual({ skipped: 'already_ran', date: DATE_STR });
    expect(executeMock).not.toHaveBeenCalled();
    expect(finishCronRunMock).not.toHaveBeenCalled();
  });

  it('claims under job "purge" keyed by the calendar date', async () => {
    await POST(purgeRequest());
    expect(claimCronRunMock).toHaveBeenCalledWith('purge', DATE_STR);
  });

  it('deletes survey_responses using the 24-month retention window', async () => {
    await POST(purgeRequest());

    const call = executeMock.mock.calls.find(([sql]) =>
      String(sql).includes('DELETE FROM survey_responses'),
    );
    expect(call).toBeDefined();
    const [sql, params] = call!;
    expect(sql).toMatch(/created_at < now\(\) - \(\$1 \|\| ' months'\)::interval/);
    expect(params).toEqual([LEGAL.surveyResponseRetentionMonths]);
    expect(LEGAL.surveyResponseRetentionMonths).toBe(24);
  });

  it('deletes themes using the same retention window', async () => {
    await POST(purgeRequest());

    const call = executeMock.mock.calls.find(([sql]) => String(sql).includes('DELETE FROM themes'));
    expect(call).toBeDefined();
    const [, params] = call!;
    expect(params).toEqual([LEGAL.surveyResponseRetentionMonths]);
  });

  it('deletes expired login_tokens with a day of slack past expiry', async () => {
    await POST(purgeRequest());

    const call = executeMock.mock.calls.find(([sql]) => String(sql).includes('DELETE FROM login_tokens'));
    expect(call).toBeDefined();
    expect(call![0]).toMatch(/expires_at < now\(\) - interval '1 day'/);
  });

  it('queries orgs due for hard-deletion using the 30-day deletion window', async () => {
    await POST(purgeRequest());

    const call = queryMock.mock.calls.find(([sql]) =>
      String(sql).includes('FROM organizations WHERE deletion_requested_at'),
    );
    expect(call).toBeDefined();
    const [sql, params] = call!;
    expect(sql).toMatch(/deletion_requested_at < now\(\) - \(\$1 \|\| ' days'\)::interval/);
    expect(params).toEqual([LEGAL.deletionWindowDays]);
    expect(LEGAL.deletionWindowDays).toBe(30);
  });

  it('hard-deletes only orgs the deletion query actually returned, via disconnectStripe then DELETE', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM organizations WHERE deletion_requested_at')) {
        return [{ id: 'org-due-1' }];
      }
      return [];
    });

    const res = await POST(purgeRequest());
    const body = await res.json();

    expect(disconnectStripeMock).toHaveBeenCalledWith('org-due-1');
    expect(executeMock).toHaveBeenCalledWith('DELETE FROM organizations WHERE id = $1', ['org-due-1']);
    expect(body.orgsDeleted).toBe(1);
  });

  it('deletes abandoned signups: 30+ days old, no Stripe key, no Polar subscription, no used login token', async () => {
    await POST(purgeRequest());

    const call = executeMock.mock.calls.find(
      ([sql]) =>
        String(sql).includes("created_at < now() - interval '30 days'") &&
        String(sql).includes('stripe_api_key_enc IS NULL'),
    );
    expect(call).toBeDefined();
    const [sql] = call!;
    expect(sql).toMatch(/polar_subscription_id IS NULL/);
    expect(sql).toMatch(/used_at IS NOT NULL/);
  });

  it('reports one failing step in `failed` while the others still run', async () => {
    executeMock.mockImplementation(async (sql: string) => {
      if (sql.includes('DELETE FROM themes')) {
        throw new Error('themes delete boom');
      }
      return 0;
    });

    const res = await POST(purgeRequest());
    const body = await res.json();

    expect(body.failed).toEqual(['themes']);
    // The other steps still ran despite themes throwing.
    expect(executeMock.mock.calls.some(([sql]) => sql.includes('DELETE FROM survey_responses'))).toBe(true);
    expect(executeMock.mock.calls.some(([sql]) => sql.includes('DELETE FROM login_tokens'))).toBe(true);
  });

  it('finishes the run failed when a step failed', async () => {
    executeMock.mockImplementation(async (sql: string) => {
      if (sql.includes('DELETE FROM themes')) throw new Error('boom');
      return 0;
    });

    await POST(purgeRequest());

    expect(finishCronRunMock).toHaveBeenCalledWith(
      'purge',
      DATE_STR,
      expect.objectContaining({ status: 'failed', failed: 1 }),
    );
  });

  it('finishes the run succeeded when nothing failed', async () => {
    await POST(purgeRequest());

    expect(finishCronRunMock).toHaveBeenCalledWith(
      'purge',
      DATE_STR,
      expect.objectContaining({ status: 'succeeded', failed: 0 }),
    );
  });

  it('returns response, theme, token, org, and abandoned counts', async () => {
    executeMock.mockImplementation(async (sql: string) => {
      if (sql.includes('DELETE FROM survey_responses')) return 3;
      if (sql.includes('DELETE FROM themes')) return 2;
      if (sql.includes('DELETE FROM login_tokens')) return 5;
      if (sql.includes("created_at < now() - interval '30 days'")) return 1; // abandoned signups
      return 0;
    });

    const res = await POST(purgeRequest());
    const body = await res.json();

    expect(body).toMatchObject({ responses: 3, themes: 2, tokens: 5, abandonedDeleted: 1 });
  });
});

// ─── Step SQL: the exact predicates the retention promises rest on ─────────
// These assert the statements the route *emits*. What those statements then do
// to real rows (the 29-vs-31-day boundary, the abandoned-signup rule against
// actual data) is verified against a live Postgres in route.db.test.ts.

/** Collapse whitespace so a multi-line template literal can be matched exactly. */
function norm(sql: unknown): string {
  return String(sql).replace(/\s+/g, ' ').trim();
}

function sqlPassedTo(mock: typeof executeMock | typeof queryMock, needle: string): string {
  const call = mock.mock.calls.find(([sql]) => String(sql).includes(needle));
  expect(call, `no statement containing ${needle}`).toBeDefined();
  return norm(call![0]);
}

describe('POST /api/purge — step predicates', () => {
  it('applies the retention window to survey_responses.created_at, in months', async () => {
    await POST(purgeRequest());

    expect(sqlPassedTo(executeMock, 'DELETE FROM survey_responses')).toBe(
      "DELETE FROM survey_responses WHERE created_at < now() - ($1 || ' months')::interval",
    );
    expect(LEGAL.surveyResponseRetentionMonths).toBe(24);
  });

  it('applies the retention window to themes.week_of, in months', async () => {
    await POST(purgeRequest());

    // week_of, not created_at: a theme row is written the week it is computed
    // but describes the week it is keyed to, and that is the date the retention
    // promise is about.
    expect(sqlPassedTo(executeMock, 'DELETE FROM themes')).toBe(
      "DELETE FROM themes WHERE week_of < now() - ($1 || ' months')::interval",
    );
  });

  it('selects orgs for hard-deletion strictly past the deletion window', async () => {
    await POST(purgeRequest());

    // `<` (not `<=`) against now() - 30 days, so 29 days ago is outside and 31
    // days ago is inside; NULL deletion_requested_at never satisfies the
    // comparison, which is what keeps every org that never asked to be deleted.
    expect(sqlPassedTo(queryMock, 'deletion_requested_at')).toBe(
      "SELECT id FROM organizations WHERE deletion_requested_at < now() - ($1 || ' days')::interval",
    );
  });

  it('never selects an abandoned signup that has a key, a subscription, or a used token', async () => {
    await POST(purgeRequest());

    // Asserted as one exact predicate rather than four independent substring
    // matches: the substrings would still pass if an AND became an OR, if the
    // NOT EXISTS lost its `lt.org_id = o.id` correlation (which would then make
    // *any* used token anywhere protect *every* org, or none), or if a
    // condition drifted into a different clause.
    expect(sqlPassedTo(executeMock, 'DELETE FROM organizations o')).toBe(
      "DELETE FROM organizations o WHERE o.created_at < now() - interval '30 days' " +
        'AND o.stripe_api_key_enc IS NULL ' +
        'AND o.polar_subscription_id IS NULL ' +
        'AND NOT EXISTS ( SELECT 1 FROM login_tokens lt ' +
        'WHERE lt.org_id = o.id AND lt.used_at IS NOT NULL )',
    );
  });

  it('deletes expired login_tokens BEFORE testing orgs for abandonment', async () => {
    await POST(purgeRequest());

    const order = executeMock.mock.calls.map(([sql]) => String(sql));
    const tokensAt = order.findIndex((sql) => sql.includes('DELETE FROM login_tokens'));
    const abandonedAt = order.findIndex((sql) => sql.includes('DELETE FROM organizations o'));

    expect(tokensAt).toBeGreaterThanOrEqual(0);
    expect(abandonedAt).toBeGreaterThanOrEqual(0);
    // Documents a real hazard, not a preference: login tokens live 15 minutes
    // (src/app/api/auth/request/route.ts TOKEN_TTL_MS) and this step removes any
    // row whose expires_at is over a day old, so the used-token row is the
    // abandoned-signup rule's only evidence that a human ever signed in — and it
    // is gone roughly a day after they did, in this very run. See the
    // it.fails case in route.db.test.ts.
    expect(tokensAt).toBeLessThan(abandonedAt);
  });
});

// ─── Fault isolation ──────────────────────────────────────────────────────

describe('POST /api/purge — one broken step does not stop the others', () => {
  /** Runs the purge with `execute` throwing for statements matching `needle`. */
  async function purgeWithFailingStatement(needle: string) {
    executeMock.mockImplementation(async (sql: string) => {
      if (sql.includes(needle)) throw new Error(`${needle} boom`);
      return 0;
    });
    const res = await POST(purgeRequest());
    return { res, body: await res.json() };
  }

  const STEPS: [string, string][] = [
    ['DELETE FROM survey_responses', 'survey_responses'],
    ['DELETE FROM themes', 'themes'],
    ['DELETE FROM login_tokens', 'login_tokens'],
    ['DELETE FROM organizations o', 'abandoned_signups'],
  ];

  it.each(STEPS)('names %s in `failed` as "%s"', async (needle, stepName) => {
    const { body } = await purgeWithFailingStatement(needle);
    expect(body.failed).toEqual([stepName]);
  });

  it.each(STEPS)('still runs every other step when %s throws', async (needle) => {
    await purgeWithFailingStatement(needle);

    const ran = executeMock.mock.calls.map(([sql]) => String(sql));
    for (const [other] of STEPS) {
      expect(ran.some((sql) => sql.includes(other))).toBe(true);
    }
  });

  it('names every failing step when more than one breaks, and counts them', async () => {
    executeMock.mockImplementation(async (sql: string) => {
      if (sql.includes('DELETE FROM themes')) throw new Error('a');
      if (sql.includes('DELETE FROM login_tokens')) throw new Error('b');
      return 0;
    });

    const res = await POST(purgeRequest());
    const body = await res.json();

    expect(body.failed).toEqual(['themes', 'login_tokens']);
    expect(finishCronRunMock).toHaveBeenCalledWith(
      'purge',
      DATE_STR,
      expect.objectContaining({ status: 'failed', failed: 2 }),
    );
  });

  it('records org_delete_query and keeps going when the due-orgs SELECT throws', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('deletion_requested_at')) throw new Error('select boom');
      return [];
    });

    const res = await POST(purgeRequest());
    const body = await res.json();

    expect(body.failed).toEqual(['org_delete_query']);
    expect(body.orgsDeleted).toBe(0);
    // The step *after* the one that threw still ran.
    expect(
      executeMock.mock.calls.some(([sql]) => String(sql).includes('DELETE FROM organizations o')),
    ).toBe(true);
  });

  it('isolates one org hard-delete failure from the next org', async () => {
    queryMock.mockImplementation(async (sql: string) =>
      sql.includes('deletion_requested_at') ? [{ id: 'org-a' }, { id: 'org-b' }] : [],
    );
    disconnectStripeMock.mockImplementation(async (orgId: string) => {
      if (orgId === 'org-a') throw new Error('stripe teardown boom');
    });

    const res = await POST(purgeRequest());
    const body = await res.json();

    expect(body.orgsDeleted).toBe(1);
    expect(body.failed).toEqual(['org_delete:org-a']);
    expect(executeMock).toHaveBeenCalledWith('DELETE FROM organizations WHERE id = $1', ['org-b']);
    expect(executeMock).not.toHaveBeenCalledWith('DELETE FROM organizations WHERE id = $1', [
      'org-a',
    ]);
  });

  it('does not delete the org row when its Stripe teardown throws', async () => {
    // Current behaviour, stated plainly: disconnectStripe swallows a failed
    // webhook-endpoint delete internally (src/lib/stripe-disconnect.ts), so it
    // only rejects if the credential-clearing UPDATE itself fails — and then the
    // org survives this run and is retried tomorrow.
    queryMock.mockImplementation(async (sql: string) =>
      sql.includes('deletion_requested_at') ? [{ id: 'org-a' }] : [],
    );
    disconnectStripeMock.mockRejectedValue(new Error('db down'));

    const res = await POST(purgeRequest());
    const body = await res.json();

    expect(body.orgsDeleted).toBe(0);
    expect(body.failed).toEqual(['org_delete:org-a']);
    expect(executeMock).not.toHaveBeenCalledWith('DELETE FROM organizations WHERE id = $1', [
      'org-a',
    ]);
  });

  it('disconnects Stripe before deleting the org row, never after', async () => {
    queryMock.mockImplementation(async (sql: string) =>
      sql.includes('deletion_requested_at') ? [{ id: 'org-a' }] : [],
    );
    const order: string[] = [];
    disconnectStripeMock.mockImplementation(async () => {
      order.push('disconnect');
    });
    executeMock.mockImplementation(async (sql: string) => {
      if (sql.includes('DELETE FROM organizations WHERE id')) order.push('delete');
      return 0;
    });

    await POST(purgeRequest());

    // The row carries the credentials the teardown needs; deleting first would
    // leave an orphaned webhook endpoint pointed at a dead org forever.
    expect(order).toEqual(['disconnect', 'delete']);
  });
});

// ─── Guards ───────────────────────────────────────────────────────────────

describe('POST /api/purge — guards', () => {
  it('touches nothing at all when unauthorized', async () => {
    verifyCronSecretMock.mockReturnValue(false);

    await POST(purgeRequest());

    expect(queryMock).not.toHaveBeenCalled();
    expect(executeMock).not.toHaveBeenCalled();
    expect(disconnectStripeMock).not.toHaveBeenCalled();
    expect(finishCronRunMock).not.toHaveBeenCalled();
  });

  it('deletes nothing when the day is already claimed by another instance', async () => {
    claimCronRunMock.mockResolvedValue(false);

    await POST(purgeRequest());

    expect(queryMock).not.toHaveBeenCalled();
    expect(executeMock).not.toHaveBeenCalled();
    expect(disconnectStripeMock).not.toHaveBeenCalled();
  });

  it('reports processed as the total rows removed across every step', async () => {
    queryMock.mockImplementation(async (sql: string) =>
      sql.includes('deletion_requested_at') ? [{ id: 'org-a' }] : [],
    );
    executeMock.mockImplementation(async (sql: string) => {
      if (sql.includes('DELETE FROM survey_responses')) return 3;
      if (sql.includes('DELETE FROM themes')) return 2;
      if (sql.includes('DELETE FROM login_tokens')) return 5;
      if (sql.includes('DELETE FROM organizations o')) return 4;
      return 1;
    });

    await POST(purgeRequest());

    expect(finishCronRunMock).toHaveBeenCalledWith(
      'purge',
      DATE_STR,
      // 3 + 2 + 5 + 1 org hard-deleted + 4 abandoned
      expect.objectContaining({ status: 'succeeded', processed: 15, failed: 0 }),
    );
  });
});
