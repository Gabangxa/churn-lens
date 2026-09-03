import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ────────────────────────────────────────────────────────────────
// No Postgres, no OpenAI in this environment: every boundary the route
// touches is stubbed. `query` is multiplexed on the SQL text since the route
// issues several different statements through the same helper.

const queryMock = vi.fn();
vi.mock('@/lib/db', () => ({
  query: (...args: unknown[]) => queryMock(...args),
}));

const clusterResponsesMock = vi.fn();
vi.mock('@/lib/openai', () => ({
  MAX_RESPONSES_PER_BATCH: 200,
  clusterResponses: (...args: unknown[]) => clusterResponsesMock(...args),
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
}));

const WEEK_OF = '2026-03-09';
vi.mock('@/lib/week', () => ({
  reportingWeek: () => ({
    weekStart: new Date('2026-03-09T00:00:00Z'),
    weekEnd: new Date('2026-03-16T00:00:00Z'),
    weekOfStr: WEEK_OF,
  }),
}));

import { POST } from '../route';

function themesRequest() {
  return new Request('http://localhost/api/themes', {
    method: 'POST',
    headers: { authorization: 'Bearer secret' },
  });
}

let orgs: { id: string }[];
let existingThemeOrgIds: Set<string>;
let responsesByOrg: Record<string, { reason_category: string; open_text: string | null }[]>;

beforeEach(() => {
  queryMock.mockReset();
  clusterResponsesMock.mockReset();
  verifyCronSecretMock.mockReset();
  claimCronRunMock.mockReset();
  finishCronRunMock.mockReset();

  verifyCronSecretMock.mockReturnValue(true);
  claimCronRunMock.mockResolvedValue(true);
  finishCronRunMock.mockResolvedValue(undefined);
  clusterResponsesMock.mockResolvedValue([
    { label: 'Too expensive', quotes: ['too pricey'], count: 1 },
  ]);

  orgs = [{ id: 'org-1' }];
  existingThemeOrgIds = new Set();
  responsesByOrg = {
    'org-1': [
      { reason_category: 'price', open_text: 'too pricey' },
      { reason_category: 'price', open_text: 'also pricey' },
    ],
  };

  queryMock.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('FROM organizations')) return orgs;
    if (sql.includes('SELECT id FROM themes')) {
      const [orgId] = params as [string, string];
      return existingThemeOrgIds.has(orgId) ? [{ id: 'existing-theme' }] : [];
    }
    if (sql.includes('SELECT reason_category')) {
      const [orgId] = params as [string, string, string];
      return responsesByOrg[orgId] ?? [];
    }
    if (sql.includes('SELECT mrr_lost')) return [{ mrr_lost: 100 }];
    if (sql.includes('INSERT INTO themes')) return [];
    if (sql.includes('SELECT id, open_text FROM survey_responses')) return [];
    if (sql.includes('UPDATE survey_responses SET theme_tags')) return [];
    return [];
  });

  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('POST /api/themes', () => {
  it('returns 401 when unauthorized', async () => {
    verifyCronSecretMock.mockReturnValue(false);
    const res = await POST(themesRequest());
    expect(res.status).toBe(401);
    expect(claimCronRunMock).not.toHaveBeenCalled();
  });

  it('returns already_ran when the claim is lost', async () => {
    claimCronRunMock.mockResolvedValue(false);
    const res = await POST(themesRequest());
    const body = await res.json();
    expect(body).toEqual({ skipped: 'already_ran', weekOf: WEEK_OF });
    expect(finishCronRunMock).not.toHaveBeenCalled();
  });

  it('one org throwing does not stop the next org; the run finishes failed with failed=1', async () => {
    orgs = [{ id: 'org-1' }, { id: 'org-2' }];
    responsesByOrg = {
      'org-1': [
        { reason_category: 'price', open_text: 'too pricey' },
        { reason_category: 'price', open_text: 'also pricey' },
      ],
      'org-2': [
        { reason_category: 'price', open_text: 'still pricey' },
        { reason_category: 'price', open_text: 'way pricey' },
      ],
    };
    clusterResponsesMock.mockImplementationOnce(() => {
      throw new Error('OpenAI down');
    });

    const res = await POST(themesRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ processed: 1, failed: 1, weekOf: WEEK_OF });
    expect(clusterResponsesMock).toHaveBeenCalledTimes(2);
    expect(finishCronRunMock).toHaveBeenCalledWith('themes', WEEK_OF, {
      status: 'failed',
      processed: 1,
      failed: 1,
    });
  });

  it('skips an org that already has themes rows for this week', async () => {
    existingThemeOrgIds.add('org-1');

    const res = await POST(themesRequest());
    const body = await res.json();

    expect(body).toEqual({ processed: 0, failed: 0, weekOf: WEEK_OF });
    expect(clusterResponsesMock).not.toHaveBeenCalled();
    expect(finishCronRunMock).toHaveBeenCalledWith('themes', WEEK_OF, {
      status: 'succeeded',
      processed: 0,
      failed: 0,
    });
  });

  it('a clean run finishes succeeded', async () => {
    const res = await POST(themesRequest());
    const body = await res.json();

    expect(body).toEqual({ processed: 1, failed: 0, weekOf: WEEK_OF });
    expect(finishCronRunMock).toHaveBeenCalledWith('themes', WEEK_OF, {
      status: 'succeeded',
      processed: 1,
      failed: 0,
    });
  });
});

/**
 * Replace the `query` mock with one that can fail a specific statement while
 * every other statement still behaves normally, so a single org (or a single
 * step) can be broken without hand-rolling the whole fixture again.
 */
function breakQuery(shouldThrow: (sql: string, params: unknown[]) => unknown) {
  const base = queryMock.getMockImplementation()!;
  queryMock.mockImplementation(async (sql: string, params: unknown[] = []) => {
    const err = shouldThrow(sql, params);
    if (err) throw err;
    return base(sql, params);
  });
}

describe('POST /api/themes — run-level failures', () => {
  it('finishes the run as failed AND returns 500 when the org lookup throws', async () => {
    breakQuery((sql) => (sql.includes('FROM organizations') ? new Error('connection terminated') : null));

    const res = await POST(themesRequest());
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toEqual({ error: 'connection terminated', weekOf: WEEK_OF });
    // Without this the row stays 'running' and the week is unretryable until
    // the 2h stale window elapses.
    expect(finishCronRunMock).toHaveBeenCalledWith('themes', WEEK_OF, {
      status: 'failed',
      processed: 0,
      failed: 0,
      error: 'connection terminated',
    });
  });

  it('records a non-Error throw as a string rather than "[object Object]"', async () => {
    breakQuery((sql) => (sql.includes('FROM organizations') ? 'pool exhausted' : null));

    const res = await POST(themesRequest());
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe('pool exhausted');
    expect(finishCronRunMock).toHaveBeenCalledWith(
      'themes',
      WEEK_OF,
      expect.objectContaining({ status: 'failed', error: 'pool exhausted' }),
    );
  });

  it('carries the partial counts into the failed finish when a later step throws', async () => {
    orgs = [{ id: 'org-1' }, { id: 'org-2' }];
    responsesByOrg = {
      'org-1': [
        { reason_category: 'price', open_text: 'too pricey' },
        { reason_category: 'price', open_text: 'also pricey' },
      ],
      'org-2': [
        { reason_category: 'price', open_text: 'still pricey' },
        { reason_category: 'price', open_text: 'way pricey' },
      ],
    };
    // org-1's theme insert blows up (outer per-org catch), org-2 succeeds.
    breakQuery((sql, params) =>
      sql.includes('INSERT INTO themes') && (params as string[])[0] === 'org-1'
        ? new Error('deadlock detected')
        : null,
    );

    const res = await POST(themesRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ processed: 1, failed: 1, weekOf: WEEK_OF });
    expect(finishCronRunMock).toHaveBeenCalledWith('themes', WEEK_OF, {
      status: 'failed',
      processed: 1,
      failed: 1,
    });
  });

  it('finishes the run exactly once on the happy path', async () => {
    await POST(themesRequest());
    expect(finishCronRunMock).toHaveBeenCalledTimes(1);
  });

  it('claims the run before reading any org', async () => {
    await POST(themesRequest());
    expect(claimCronRunMock).toHaveBeenCalledWith('themes', WEEK_OF);
    expect(claimCronRunMock.mock.invocationCallOrder[0]).toBeLessThan(
      queryMock.mock.invocationCallOrder[0],
    );
  });

  it('does no work at all when the claim is lost', async () => {
    claimCronRunMock.mockResolvedValue(false);
    await POST(themesRequest());
    expect(queryMock).not.toHaveBeenCalled();
    expect(clusterResponsesMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/themes — per-org isolation', () => {
  it('a failing org does not consume the next org’s turn: the next org is still clustered', async () => {
    orgs = [{ id: 'org-1' }, { id: 'org-2' }];
    responsesByOrg = {
      'org-1': [
        { reason_category: 'price', open_text: 'org one a' },
        { reason_category: 'price', open_text: 'org one b' },
      ],
      'org-2': [
        { reason_category: 'ux', open_text: 'org two a' },
        { reason_category: 'ux', open_text: 'org two b' },
      ],
    };
    clusterResponsesMock.mockImplementationOnce(() => {
      throw new Error('OpenAI down');
    });

    await POST(themesRequest());

    // The surviving call must be org-2's payload, not a retry of org-1's.
    expect(clusterResponsesMock).toHaveBeenCalledTimes(2);
    expect(clusterResponsesMock.mock.calls[1][0]).toEqual([
      { text: 'org two a', reason: 'ux' },
      { text: 'org two b', reason: 'ux' },
    ]);
  });

  it('a failing org writes no themes rows for itself', async () => {
    orgs = [{ id: 'org-1' }, { id: 'org-2' }];
    responsesByOrg = {
      'org-1': [
        { reason_category: 'price', open_text: 'org one a' },
        { reason_category: 'price', open_text: 'org one b' },
      ],
      'org-2': [
        { reason_category: 'ux', open_text: 'org two a' },
        { reason_category: 'ux', open_text: 'org two b' },
      ],
    };
    clusterResponsesMock.mockImplementationOnce(() => {
      throw new Error('OpenAI down');
    });

    await POST(themesRequest());

    const insertedOrgIds = queryMock.mock.calls
      .filter(([sql]) => (sql as string).includes('INSERT INTO themes'))
      .map(([, params]) => (params as string[])[0]);
    expect(insertedOrgIds).toEqual(['org-2']);
  });

  it('the skip-on-retry check is scoped to (org, week)', async () => {
    await POST(themesRequest());
    const call = queryMock.mock.calls.find(([sql]) =>
      (sql as string).includes('SELECT id FROM themes'),
    );
    expect(call?.[1]).toEqual(['org-1', WEEK_OF]);
  });
});

describe('POST /api/themes — orgs with nothing to cluster', () => {
  it('no paid orgs at all still finishes the run as succeeded', async () => {
    orgs = [];

    const res = await POST(themesRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ processed: 0, failed: 0, weekOf: WEEK_OF });
    expect(clusterResponsesMock).not.toHaveBeenCalled();
    expect(finishCronRunMock).toHaveBeenCalledWith('themes', WEEK_OF, {
      status: 'succeeded',
      processed: 0,
      failed: 0,
    });
  });

  it('an org with a single response is skipped, not failed', async () => {
    responsesByOrg = { 'org-1': [{ reason_category: 'price', open_text: 'only one' }] };

    const res = await POST(themesRequest());
    const body = await res.json();

    expect(body).toEqual({ processed: 0, failed: 0, weekOf: WEEK_OF });
    expect(clusterResponsesMock).not.toHaveBeenCalled();
  });

  it('an org whose responses have no open text is skipped, not failed', async () => {
    responsesByOrg = {
      'org-1': [
        { reason_category: 'price', open_text: null },
        { reason_category: 'price', open_text: null },
      ],
    };

    const res = await POST(themesRequest());
    const body = await res.json();

    expect(body).toEqual({ processed: 0, failed: 0, weekOf: WEEK_OF });
    expect(clusterResponsesMock).not.toHaveBeenCalled();
    expect(finishCronRunMock).toHaveBeenCalledWith('themes', WEEK_OF, {
      status: 'succeeded',
      processed: 0,
      failed: 0,
    });
  });
});

describe('POST /api/themes — theme rows', () => {
  it('splits the week’s MRR across themes by their share of the clustered input', async () => {
    responsesByOrg = {
      'org-1': [
        { reason_category: 'price', open_text: 'a' },
        { reason_category: 'price', open_text: 'b' },
      ],
    };
    clusterResponsesMock.mockResolvedValue([
      { label: 'Too expensive', quotes: ['a'], count: 1 },
      { label: 'Missing feature', quotes: ['b'], count: 1 },
    ]);
    const base = queryMock.getMockImplementation()!;
    queryMock.mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('SELECT mrr_lost')) return [{ mrr_lost: 100 }, { mrr_lost: 50 }];
      return base(sql, params);
    });

    await POST(themesRequest());

    const inserts = queryMock.mock.calls
      .filter(([sql]) => (sql as string).includes('INSERT INTO themes'))
      .map(([, params]) => params as unknown[]);

    expect(inserts).toHaveLength(2);
    // 150 total MRR, 1 of 2 clustered responses each → 75 apiece.
    expect(inserts[0]).toEqual(['org-1', WEEK_OF, 'Too expensive', 1, ['a'], 75]);
    expect(inserts[1]).toEqual(['org-1', WEEK_OF, 'Missing feature', 1, ['b'], 75]);
  });

  it('back-tags the response whose text matches the quote, ignoring case and padding', async () => {
    responsesByOrg = {
      'org-1': [
        { reason_category: 'price', open_text: 'Too  Pricey' },
        { reason_category: 'price', open_text: 'something else' },
      ],
    };
    clusterResponsesMock.mockResolvedValue([
      { label: 'Too expensive', quotes: ['  too pricey  '], count: 1 },
    ]);
    const base = queryMock.getMockImplementation()!;
    queryMock.mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('SELECT id, open_text FROM survey_responses')) {
        return [
          { id: 'resp-1', open_text: 'Too  Pricey' },
          { id: 'resp-2', open_text: 'something else' },
        ];
      }
      return base(sql, params);
    });

    await POST(themesRequest());

    const tagCalls = queryMock.mock.calls.filter(([sql]) =>
      (sql as string).includes('UPDATE survey_responses SET theme_tags'),
    );
    expect(tagCalls).toHaveLength(1);
    expect(tagCalls[0][1]).toEqual([['Too expensive'], 'resp-1']);
  });

  it('back-tags nothing when the model returns a quote it invented', async () => {
    clusterResponsesMock.mockResolvedValue([
      { label: 'Too expensive', quotes: ['a quote nobody wrote'], count: 1 },
    ]);
    const base = queryMock.getMockImplementation()!;
    queryMock.mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('SELECT id, open_text FROM survey_responses')) {
        return [{ id: 'resp-1', open_text: 'too pricey' }];
      }
      return base(sql, params);
    });

    await POST(themesRequest());

    expect(
      queryMock.mock.calls.filter(([sql]) =>
        (sql as string).includes('UPDATE survey_responses SET theme_tags'),
      ),
    ).toHaveLength(0);
  });
});
