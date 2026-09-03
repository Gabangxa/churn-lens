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
