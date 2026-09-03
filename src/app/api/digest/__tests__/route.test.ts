import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ────────────────────────────────────────────────────────────────
// No Postgres, no Resend in this environment: every boundary the route
// touches is stubbed. `query`/`queryOne` are multiplexed on the SQL text
// since the route issues several different statements through each helper.

const queryMock = vi.fn();
const queryOneMock = vi.fn();
const queryCountMock = vi.fn();
const executeMock = vi.fn();
vi.mock('@/lib/db', () => ({
  query: (...args: unknown[]) => queryMock(...args),
  queryOne: (...args: unknown[]) => queryOneMock(...args),
  queryCount: (...args: unknown[]) => queryCountMock(...args),
  execute: (...args: unknown[]) => executeMock(...args),
}));

const resendSendMock = vi.fn();
vi.mock('@/lib/resend', () => ({
  getResend: () => ({ emails: { send: (...args: unknown[]) => resendSendMock(...args) } }),
  FROM_EMAIL: 'digest@churnlens.com',
}));

const verifyCronSecretMock = vi.fn();
vi.mock('@/lib/auth', () => ({
  verifyCronSecret: (...args: unknown[]) => verifyCronSecretMock(...args),
}));

const claimCronRunMock = vi.fn();
const cronRunStatusMock = vi.fn();
const finishCronRunMock = vi.fn();
vi.mock('@/lib/cron', () => ({
  claimCronRun: (...args: unknown[]) => claimCronRunMock(...args),
  cronRunStatus: (...args: unknown[]) => cronRunStatusMock(...args),
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

function digestRequest() {
  return new Request('http://localhost/api/digest', {
    method: 'POST',
    headers: { authorization: 'Bearer secret' },
  });
}

const ORG = { id: 'org-1', name: 'Acme' };
const FOUNDER = { email: 'founder@acme.com', name: 'Jane Founder' };
const THEME_ROW = {
  org_id: ORG.id,
  label: 'Too expensive',
  response_count: 5,
  representative_quotes: ['too pricey'],
  mrr_impact: 200,
};

let themesRows: typeof THEME_ROW[];
let alreadySentOrgIds: Set<string>;

beforeEach(() => {
  queryMock.mockReset();
  queryOneMock.mockReset();
  queryCountMock.mockReset();
  executeMock.mockReset();
  resendSendMock.mockReset();
  verifyCronSecretMock.mockReset();
  claimCronRunMock.mockReset();
  cronRunStatusMock.mockReset();
  finishCronRunMock.mockReset();

  verifyCronSecretMock.mockReturnValue(true);
  cronRunStatusMock.mockResolvedValue('succeeded');
  claimCronRunMock.mockResolvedValue(true);
  finishCronRunMock.mockResolvedValue(undefined);
  resendSendMock.mockResolvedValue({ data: { id: 'email_1' }, error: null });
  executeMock.mockResolvedValue(1);
  queryCountMock.mockResolvedValue(3);

  themesRows = [THEME_ROW];
  alreadySentOrgIds = new Set();

  queryMock.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM themes WHERE week_of')) return themesRows;
    if (sql.includes('FROM organizations WHERE id = ANY')) return [ORG];
    if (sql.includes('SELECT mrr_lost')) return [{ mrr_lost: 100 }];
    return [];
  });

  queryOneMock.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('FROM digest_sends')) {
      const [orgId] = params as [string, string];
      return alreadySentOrgIds.has(orgId) ? { org_id: orgId } : null;
    }
    if (sql.includes('FROM users')) return FOUNDER;
    return null;
  });

  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('POST /api/digest', () => {
  it('returns 401 when unauthorized', async () => {
    verifyCronSecretMock.mockReturnValue(false);
    const res = await POST(digestRequest());
    expect(res.status).toBe(401);
    expect(cronRunStatusMock).not.toHaveBeenCalled();
  });

  it('defers without claiming when themes has not succeeded for this week', async () => {
    cronRunStatusMock.mockResolvedValue('running');
    const res = await POST(digestRequest());
    const body = await res.json();

    expect(body).toEqual({ deferred: 'themes_not_ready', weekOf: WEEK_OF });
    expect(claimCronRunMock).not.toHaveBeenCalled();
  });

  it('defers when themes has never run (status null)', async () => {
    cronRunStatusMock.mockResolvedValue(null);
    const res = await POST(digestRequest());
    const body = await res.json();

    expect(body).toEqual({ deferred: 'themes_not_ready', weekOf: WEEK_OF });
    expect(claimCronRunMock).not.toHaveBeenCalled();
  });

  it('returns already_ran when the claim is lost', async () => {
    claimCronRunMock.mockResolvedValue(false);
    const res = await POST(digestRequest());
    const body = await res.json();

    expect(body).toEqual({ sent: 0, skipped: 'already_ran', weekOf: WEEK_OF });
    expect(finishCronRunMock).not.toHaveBeenCalled();
  });

  it('a Resend send error counts as failed and does not record a digest_sends row', async () => {
    resendSendMock.mockResolvedValue({
      data: null,
      error: { name: 'validation_error', message: 'bad address' },
    });

    const res = await POST(digestRequest());
    const body = await res.json();

    expect(body).toEqual({ sent: 0, failed: 1, weekOf: WEEK_OF });
    expect(executeMock).not.toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO digest_sends'),
      expect.anything(),
    );
    expect(finishCronRunMock).toHaveBeenCalledWith('digest', WEEK_OF, {
      status: 'failed',
      processed: 0,
      failed: 1,
    });
  });

  it('skips an org that already has a digest_sends row for this week', async () => {
    alreadySentOrgIds.add(ORG.id);

    const res = await POST(digestRequest());
    const body = await res.json();

    expect(body).toEqual({ sent: 0, failed: 0, weekOf: WEEK_OF });
    expect(resendSendMock).not.toHaveBeenCalled();
    expect(finishCronRunMock).toHaveBeenCalledWith('digest', WEEK_OF, {
      status: 'succeeded',
      processed: 0,
      failed: 0,
    });
  });

  it('a successful send inserts a digest_sends row and finishes succeeded', async () => {
    const res = await POST(digestRequest());
    const body = await res.json();

    expect(body).toEqual({ sent: 1, failed: 0, weekOf: WEEK_OF });
    expect(executeMock).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO digest_sends'),
      [ORG.id, WEEK_OF],
    );
    expect(finishCronRunMock).toHaveBeenCalledWith('digest', WEEK_OF, {
      status: 'succeeded',
      processed: 1,
      failed: 0,
    });
  });

  it('finishes succeeded (not left running) when no themes exist for the week', async () => {
    themesRows = [];

    const res = await POST(digestRequest());
    const body = await res.json();

    expect(body).toEqual({ sent: 0, weekOf: WEEK_OF });
    expect(finishCronRunMock).toHaveBeenCalledWith('digest', WEEK_OF, {
      status: 'succeeded',
      processed: 0,
      failed: 0,
    });
  });
});
