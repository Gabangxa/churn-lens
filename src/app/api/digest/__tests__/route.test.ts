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

// MAX_ATTEMPTS is a plain value (not a closure deferring its lookup), so
// building it via vi.hoisted() — rather than a normal top-level const read
// directly inside the factory below — avoids a temporal-dead-zone
// ReferenceError: vi.mock factories run when this file's imports are
// evaluated, which happens before its own top-level const declarations do.
const { MAX_ATTEMPTS } = vi.hoisted(() => ({ MAX_ATTEMPTS: 5 }));
const claimCronRunMock = vi.fn();
const cronRunRecordMock = vi.fn();
const finishCronRunMock = vi.fn();
vi.mock('@/lib/cron', () => ({
  claimCronRun: (...args: unknown[]) => claimCronRunMock(...args),
  cronRunRecord: (...args: unknown[]) => cronRunRecordMock(...args),
  finishCronRun: (...args: unknown[]) => finishCronRunMock(...args),
  MAX_ATTEMPTS,
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

/** A themes cron_runs record — succeeded by default (the terminal, happy case). */
function themesRecord(overrides: { status?: 'succeeded' | 'failed' | 'running'; attempts?: number } = {}) {
  return {
    status: overrides.status ?? 'succeeded',
    ranAt: new Date('2026-03-16T06:05:00Z'),
    attempts: overrides.attempts ?? 1,
  };
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
  cronRunRecordMock.mockReset();
  finishCronRunMock.mockReset();

  verifyCronSecretMock.mockReturnValue(true);
  cronRunRecordMock.mockResolvedValue(themesRecord());
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
    expect(cronRunRecordMock).not.toHaveBeenCalled();
  });

  it('defers without claiming when themes is still running', async () => {
    cronRunRecordMock.mockResolvedValue(themesRecord({ status: 'running' }));
    const res = await POST(digestRequest());
    const body = await res.json();

    expect(body).toEqual({ deferred: 'themes_not_ready', weekOf: WEEK_OF });
    expect(claimCronRunMock).not.toHaveBeenCalled();
  });

  it('defers when themes has never run (record null)', async () => {
    cronRunRecordMock.mockResolvedValue(null);
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

  it('adds the plan filter to the org lookup, matching themes', async () => {
    await POST(digestRequest());
    const call = queryMock.mock.calls.find(([sql]) =>
      (sql as string).includes('FROM organizations WHERE id = ANY'),
    );
    expect(call?.[0]).toContain("AND plan IN ('starter', 'growth')");
  });
});

const ORG_2 = { id: 'org-2', name: 'Globex' };
const FOUNDER_2 = { email: 'founder@globex.com', name: 'Sam Second' };
const THEME_ROW_2 = {
  org_id: ORG_2.id,
  label: 'Missing integrations',
  response_count: 4,
  representative_quotes: ['no zapier'],
  mrr_impact: 90,
};

/** Two orgs, each with one theme and one owner, both un-sent for the week. */
function twoOrgFixture() {
  themesRows = [THEME_ROW, THEME_ROW_2];
  queryMock.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM themes WHERE week_of')) return themesRows;
    if (sql.includes('FROM organizations WHERE id = ANY')) return [ORG, ORG_2];
    if (sql.includes('SELECT mrr_lost')) return [{ mrr_lost: 100 }];
    return [];
  });
  queryOneMock.mockImplementation(async (sql: string, params: unknown[] = []) => {
    const [orgId] = params as [string, string];
    if (sql.includes('FROM digest_sends')) {
      return alreadySentOrgIds.has(orgId) ? { org_id: orgId } : null;
    }
    if (sql.includes('FROM users')) return orgId === ORG.id ? FOUNDER : FOUNDER_2;
    return null;
  });
}

function sentTo(): string[] {
  return resendSendMock.mock.calls.map(([arg]) => (arg as { to: string }).to);
}

describe('POST /api/digest — deferral gate', () => {
  it('defers while themes is failed but still under its attempts cap', async () => {
    cronRunRecordMock.mockResolvedValue(themesRecord({ status: 'failed', attempts: MAX_ATTEMPTS - 1 }));

    const res = await POST(digestRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ deferred: 'themes_not_ready', weekOf: WEEK_OF });
    expect(claimCronRunMock).not.toHaveBeenCalled();
    // Deferring must not touch the digest run row at all — writing a status
    // here would make the week look attempted and burn a retry.
    expect(finishCronRunMock).not.toHaveBeenCalled();
    expect(resendSendMock).not.toHaveBeenCalled();
  });

  it('proceeds once themes has exhausted its retries, even though it never succeeded', async () => {
    // themes gave up after MAX_ATTEMPTS failures (e.g. one poison org kept
    // throwing); whatever theme rows exist are final. Digest must not wait
    // forever on a 'succeeded' status that will never arrive, or every
    // founder's digest — not just the poisoned org's — gets silenced.
    cronRunRecordMock.mockResolvedValue(themesRecord({ status: 'failed', attempts: MAX_ATTEMPTS }));

    const res = await POST(digestRequest());
    const body = await res.json();

    expect(body).not.toHaveProperty('deferred');
    expect(claimCronRunMock).toHaveBeenCalledWith('digest', WEEK_OF);
    expect(body).toEqual({ sent: 1, failed: 0, weekOf: WEEK_OF });
  });

  it.each(['running', null] as const)(
    'sends nothing and claims nothing when themes record is %s',
    async (status) => {
      cronRunRecordMock.mockResolvedValue(status === null ? null : themesRecord({ status }));

      const res = await POST(digestRequest());

      expect((await res.json()).deferred).toBe('themes_not_ready');
      expect(claimCronRunMock).not.toHaveBeenCalled();
      expect(resendSendMock).not.toHaveBeenCalled();
      expect(finishCronRunMock).not.toHaveBeenCalled();
    },
  );

  it('checks the themes run record before claiming the digest run', async () => {
    await POST(digestRequest());
    expect(cronRunRecordMock).toHaveBeenCalledWith('themes', WEEK_OF);
    expect(cronRunRecordMock.mock.invocationCallOrder[0]).toBeLessThan(
      claimCronRunMock.mock.invocationCallOrder[0],
    );
  });

  it('emails nobody when the claim is lost', async () => {
    claimCronRunMock.mockResolvedValue(false);
    await POST(digestRequest());
    expect(resendSendMock).not.toHaveBeenCalled();
    expect(queryMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/digest — per-org isolation', () => {
  it('one org’s DB error does not stop the next org from being emailed', async () => {
    twoOrgFixture();
    const base = queryOneMock.getMockImplementation()!;
    queryOneMock.mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('FROM users') && (params as string[])[0] === ORG.id) {
        throw new Error('connection terminated');
      }
      return base(sql, params);
    });

    const res = await POST(digestRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ sent: 1, failed: 1, weekOf: WEEK_OF });
    expect(sentTo()).toEqual([FOUNDER_2.email]);
    expect(finishCronRunMock).toHaveBeenCalledWith('digest', WEEK_OF, {
      status: 'failed',
      processed: 1,
      failed: 1,
    });
  });

  it('a Resend failure for one org does not stop the next org from being emailed', async () => {
    twoOrgFixture();
    resendSendMock.mockResolvedValueOnce({
      data: null,
      error: { name: 'rate_limit_exceeded', message: 'slow down' },
    });

    const body = await (await POST(digestRequest())).json();

    expect(body).toEqual({ sent: 1, failed: 1, weekOf: WEEK_OF });
    expect(sentTo()).toEqual([FOUNDER.email, FOUNDER_2.email]);
    // Only the org that actually received mail gets a send row, so the retry
    // re-sends the failed one and skips the delivered one.
    const sendRowOrgIds = executeMock.mock.calls
      .filter(([sql]) => (sql as string).includes('INSERT INTO digest_sends'))
      .map(([, params]) => (params as string[])[0]);
    expect(sendRowOrgIds).toEqual([ORG_2.id]);
  });

  it('a Resend error records no send row at all', async () => {
    resendSendMock.mockResolvedValue({
      data: null,
      error: { name: 'validation_error', message: 'bad address' },
    });

    await POST(digestRequest());

    expect(executeMock).not.toHaveBeenCalled();
  });

  it('an org already in digest_sends is skipped while the other org is still emailed', async () => {
    twoOrgFixture();
    alreadySentOrgIds.add(ORG.id);

    const body = await (await POST(digestRequest())).json();

    expect(body).toEqual({ sent: 1, failed: 0, weekOf: WEEK_OF });
    expect(sentTo()).toEqual([FOUNDER_2.email]);
    expect(finishCronRunMock).toHaveBeenCalledWith('digest', WEEK_OF, {
      status: 'succeeded',
      processed: 1,
      failed: 0,
    });
  });

  it('the digest_sends lookup is scoped to (org, week)', async () => {
    await POST(digestRequest());
    const call = queryOneMock.mock.calls.find(([sql]) =>
      (sql as string).includes('FROM digest_sends'),
    );
    expect(call?.[1]).toEqual([ORG.id, WEEK_OF]);
  });

  it('an org with no owner user is skipped without being counted as failed, but is logged', async () => {
    queryOneMock.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM digest_sends')) return null;
      if (sql.includes('FROM users')) return null;
      return null;
    });
    const warn = console.warn as unknown as ReturnType<typeof vi.fn>;

    const body = await (await POST(digestRequest())).json();

    expect(body).toEqual({ sent: 0, failed: 0, weekOf: WEEK_OF });
    expect(resendSendMock).not.toHaveBeenCalled();
    expect(warn.mock.calls.flat().join(' ')).toContain(ORG.id);
    expect(finishCronRunMock).toHaveBeenCalledWith('digest', WEEK_OF, {
      status: 'succeeded',
      processed: 0,
      failed: 0,
    });
  });
});

describe('POST /api/digest — run-level failures', () => {
  it('finishes the run as failed AND returns 500 when the themes read throws', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM themes WHERE week_of')) throw new Error('connection terminated');
      return [];
    });

    const res = await POST(digestRequest());
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toEqual({ error: 'connection terminated', weekOf: WEEK_OF });
    expect(finishCronRunMock).toHaveBeenCalledWith('digest', WEEK_OF, {
      status: 'failed',
      processed: 0,
      failed: 0,
      error: 'connection terminated',
    });
  });

  it('records a non-Error throw as a string', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM themes WHERE week_of')) throw 'pool exhausted';
      return [];
    });

    const res = await POST(digestRequest());
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('pool exhausted');
    expect(finishCronRunMock).toHaveBeenCalledWith(
      'digest',
      WEEK_OF,
      expect.objectContaining({ status: 'failed', error: 'pool exhausted' }),
    );
  });

  it('finishes the run exactly once on the happy path', async () => {
    await POST(digestRequest());
    expect(finishCronRunMock).toHaveBeenCalledTimes(1);
  });

  it('looks orgs up by exactly the org ids that have themes this week', async () => {
    twoOrgFixture();
    await POST(digestRequest());

    const call = queryMock.mock.calls.find(([sql]) =>
      (sql as string).includes('FROM organizations WHERE id = ANY'),
    );
    expect(call?.[1]).toEqual([[ORG.id, ORG_2.id]]);
  });
});

describe('POST /api/digest — email contents', () => {
  it('addresses the founder from the configured sender and names the top theme', async () => {
    await POST(digestRequest());

    expect(resendSendMock).toHaveBeenCalledTimes(1);
    const payload = resendSendMock.mock.calls[0][0] as {
      from: string;
      to: string;
      subject: string;
      text: string;
    };
    expect(payload.from).toBe('digest@churnlens.com');
    expect(payload.to).toBe(FOUNDER.email);
    expect(payload.subject).toBe('ChurnLens weekly: Too expensive + 3 cancellations');
    expect(payload.text).toContain('Hey Jane,');
    expect(payload.text).toContain(WEEK_OF);
    expect(payload.text).toContain('3 cancellations');
    expect(payload.text).toContain('$100 MRR lost');
  });

  it('never leaks another org’s themes into an org’s digest', async () => {
    twoOrgFixture();
    await POST(digestRequest());

    const [first, second] = resendSendMock.mock.calls.map(([a]) => a as { to: string; text: string });
    expect(first.to).toBe(FOUNDER.email);
    expect(first.text).toContain(THEME_ROW.label);
    expect(first.text).not.toContain(THEME_ROW_2.label);
    expect(second.to).toBe(FOUNDER_2.email);
    expect(second.text).toContain(THEME_ROW_2.label);
    expect(second.text).not.toContain(THEME_ROW.label);
  });

  it('lists at most the top three themes', async () => {
    themesRows = [1, 2, 3, 4].map((n) => ({
      org_id: ORG.id,
      label: `Theme ${n}`,
      response_count: 10 - n,
      representative_quotes: [`quote ${n}`],
      mrr_impact: n * 10,
    }));

    await POST(digestRequest());

    const text = (resendSendMock.mock.calls[0][0] as { text: string }).text;
    expect(text).toContain('#1  Theme 1');
    expect(text).toContain('#3  Theme 3');
    expect(text).not.toContain('Theme 4');
  });

  it('falls back to "there" when the owner has no name', async () => {
    queryOneMock.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM digest_sends')) return null;
      if (sql.includes('FROM users')) return { email: FOUNDER.email, name: null };
      return null;
    });

    await POST(digestRequest());

    const text = (resendSendMock.mock.calls[0][0] as { text: string }).text;
    expect(text).toContain('Hey there,');
  });
});
