import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const verifyCronSecretMock = vi.fn();
vi.mock('@/lib/auth', () => ({
  verifyCronSecret: (...args: unknown[]) => verifyCronSecretMock(...args),
}));

const queryMock = vi.fn();
const queryOneMock = vi.fn();
vi.mock('@/lib/db', () => ({
  query: (...args: unknown[]) => queryMock(...args),
  queryOne: (...args: unknown[]) => queryOneMock(...args),
}));

const SCHEDULER = {
  enabled: true,
  startedAt: '2026-03-16T07:00:00.000Z',
  lastPollAt: '2026-03-16T07:50:00.000Z',
  lastPollError: null,
};
vi.mock('@/lib/scheduler-state', () => ({ getSchedulerState: () => ({ ...SCHEDULER }) }));

const legalFooterReadyMock = vi.fn();
vi.mock('@/lib/legal', () => ({ legalFooterReady: () => legalFooterReadyMock() }));

import { GET, type StatusResponse, type PipelineJob } from '../route';

// Monday 2026-03-16 08:00 UTC: past both weekly due times, reporting week
// 2026-03-09, purge keyed by 2026-03-16 and due (after 03:00 UTC).
const NOW = new Date('2026-03-16T08:00:00Z');
const WEEK_OF = '2026-03-09';
const TODAY = '2026-03-16';

type CronRow = {
  job: string;
  status: 'running' | 'succeeded' | 'failed';
  attempts: number;
  ran_at: Date;
  finished_at: Date | null;
  processed: number;
  failed: number;
  error: string | null;
};

const ORGS_ROW = { total: 7, connected: 4, paid: 2, pending_deletion: 1, logins_24h: 3, logins_7d: 5 };
const LINKS_ROW = { requested_24h: 6, used_24h: 4 };
const SURVEYS_ROW = { responded_today: 1, responded_7d: 9, awaiting_email: 2 };

/** Route every aggregate query to a canned row by a distinctive SQL fragment. */
function stubQueries(overrides: Partial<Record<string, unknown>> = {}) {
  queryOneMock.mockImplementation(async (sql: string) => {
    if (sql.includes('SELECT 1')) return overrides.ping ?? { '?column?': 1 };
    if (sql.includes('FROM organizations')) return ORGS_ROW;
    if (sql.includes('FROM login_tokens')) return LINKS_ROW;
    if (sql.includes('FROM survey_responses')) {
      if (overrides.surveysThrow) throw new Error('column "nope" does not exist');
      return SURVEYS_ROW;
    }
    if (sql.includes('FROM digest_sends')) return { count: 3 };
    if (sql.includes('FROM unsubscribes')) return { count: 11 };
    throw new Error(`unexpected queryOne: ${sql}`);
  });
}

function stubCronRows(rows: CronRow[]) {
  queryMock.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM cron_runs')) return rows;
    throw new Error(`unexpected query: ${sql}`);
  });
}

function cronRow(job: string, partial: Partial<CronRow> = {}): CronRow {
  return {
    job,
    status: 'succeeded',
    attempts: 1,
    ran_at: new Date('2026-03-16T06:01:00Z'),
    finished_at: new Date('2026-03-16T06:02:00Z'),
    processed: 2,
    failed: 0,
    error: null,
    ...partial,
  };
}

function request(auth: string | null = 'Bearer secret') {
  const headers: Record<string, string> = auth === null ? {} : { authorization: auth };
  return new Request('http://localhost/api/admin/status', { headers });
}

async function body(res: Response) {
  return res.json() as Promise<StatusResponse>;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  verifyCronSecretMock.mockReset().mockReturnValue(true);
  legalFooterReadyMock.mockReset().mockReturnValue(false);
  queryMock.mockReset();
  queryOneMock.mockReset();
  stubQueries();
  stubCronRows([]);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('GET /api/admin/status — auth', () => {
  it('rejects a bad secret before touching the database', async () => {
    verifyCronSecretMock.mockReturnValue(false);

    const res = await GET(request('Bearer wrong'));

    expect(res.status).toBe(401);
    expect(await body(res)).toEqual({ error: 'Unauthorized' });
    expect(queryMock).not.toHaveBeenCalled();
    expect(queryOneMock).not.toHaveBeenCalled();
  });

  it('rejects a request with no authorization header at all', async () => {
    verifyCronSecretMock.mockReturnValue(false);

    const res = await GET(request(null));

    expect(res.status).toBe(401);
    expect(verifyCronSecretMock).toHaveBeenCalledWith(null);
  });

  it('issues no mutating SQL — this is a read-only route reachable with CRON_SECRET', async () => {
    await GET(request());

    const statements = [...queryMock.mock.calls, ...queryOneMock.mock.calls].map(([sql]) => String(sql));
    expect(statements.length).toBeGreaterThan(0);
    for (const sql of statements) {
      expect(sql).not.toMatch(/\b(insert|update|delete|truncate|drop|alter)\b/i);
    }
  });
});

describe('GET /api/admin/status — shape', () => {
  it('returns every section, uncached', async () => {
    const res = await GET(request());

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const json = await body(res);
    expect(Object.keys(json).sort()).toEqual(
      ['activity', 'app', 'db', 'errors', 'generatedAt', 'legal', 'pipeline', 'scheduler'],
    );
    expect(json.generatedAt).toBe(NOW.toISOString());
    expect(json.db).toEqual({ ok: true, latencyMs: expect.any(Number) });
    expect(json.scheduler).toEqual(SCHEDULER);
    expect(json.errors).toEqual([]);
    expect(json.app).toMatchObject({
      uptimeSec: expect.any(Number),
      nodeVersion: process.version,
      rssMb: expect.any(Number),
    });
  });

  it('reports whether the legal footer is filled in, since that gates survey sends', async () => {
    legalFooterReadyMock.mockReturnValue(false);
    expect((await body(await GET(request()))).legal.footerReady).toBe(false);

    legalFooterReadyMock.mockReturnValue(true);
    expect((await body(await GET(request()))).legal.footerReady).toBe(true);
  });

  it('reads the commit from RAILWAY_GIT_COMMIT_SHA when present, else null', async () => {
    expect((await body(await GET(request()))).app.commit).toBeNull();

    vi.stubEnv('RAILWAY_GIT_COMMIT_SHA', 'abc1234def');
    expect((await body(await GET(request()))).app.commit).toBe('abc1234def');
  });
});

describe('GET /api/admin/status — pipeline', () => {
  it('keys weekly jobs by the reporting week and purge by today, in a fixed order', async () => {
    const pipeline = (await body(await GET(request()))).pipeline!;

    expect(pipeline.weekOf).toBe(WEEK_OF);
    expect(pipeline.today).toBe(TODAY);
    expect(pipeline.jobs.map((j: PipelineJob) => j.job)).toEqual(['themes', 'digest', 'purge']);
    expect(pipeline.jobs[0]).toMatchObject({ keyedBy: WEEK_OF, dueAt: '2026-03-16T06:00:00.000Z', due: true });
    expect(pipeline.jobs[1]).toMatchObject({ keyedBy: WEEK_OF, dueAt: '2026-03-16T07:00:00.000Z', due: true });
    expect(pipeline.jobs[2]).toMatchObject({ keyedBy: TODAY, dueAt: null, due: true });

    expect(queryMock).toHaveBeenCalledWith(expect.stringContaining('FROM cron_runs'), [
      ['themes', 'digest'],
      WEEK_OF,
      TODAY,
    ]);
  });

  it('derives the scheduler action the same way the poll loop does', async () => {
    stubCronRows([
      cronRow('themes', { status: 'succeeded' }),
      cronRow('digest', { status: 'failed', attempts: 5, error: 'resend 500' }),
      cronRow('purge', { status: 'running', attempts: 1, ran_at: new Date('2026-03-16T04:00:00Z'), finished_at: null }),
    ]);

    const pipeline = (await body(await GET(request()))).pipeline!;
    const [themes, digest, purge] = pipeline.jobs;

    expect(themes).toMatchObject({ status: 'succeeded', action: 'skip', ranAt: '2026-03-16T06:01:00.000Z' });
    expect(digest).toMatchObject({ status: 'failed', attempts: 5, action: 'exhausted', error: 'resend 500' });
    // running for 4h > 2h stale window -> reclaimable
    expect(purge).toMatchObject({ status: 'running', action: 'call', finishedAt: null });
  });

  it('does not claim a job will run before it is due, whatever cron_runs says', async () => {
    // 02:00 Monday: before purge (03:00), themes (06:00) and digest (07:00).
    // The poll loop checks isDue before it consults cron_runs, so even a
    // failed row with budget left is not going to be called yet.
    vi.setSystemTime(new Date('2026-03-16T02:00:00Z'));
    stubCronRows([cronRow('digest', { status: 'failed', attempts: 1, ran_at: new Date('2026-03-15T07:05:00Z') })]);

    const pipeline = (await body(await GET(request()))).pipeline!;

    expect(pipeline.jobs.map((j: PipelineJob) => [j.job, j.due, j.action])).toEqual([
      ['themes', false, 'skip'],
      ['digest', false, 'skip'],
      ['purge', false, 'skip'],
    ]);
    expect(pipeline.jobs[0].dueAt).toBe('2026-03-16T06:00:00.000Z');
  });

  it('treats a fresh running row as in progress and a missing row as never run', async () => {
    stubCronRows([cronRow('themes', { status: 'running', ran_at: new Date('2026-03-16T07:45:00Z'), finished_at: null })]);

    const pipeline = (await body(await GET(request()))).pipeline!;

    expect(pipeline.jobs[0]).toMatchObject({ status: 'running', action: 'skip' });
    expect(pipeline.jobs[1]).toMatchObject({ status: null, attempts: null, ranAt: null, action: 'call' });
  });
});

describe('GET /api/admin/status — activity', () => {
  it('maps the aggregate rows onto the activity section', async () => {
    const activity = (await body(await GET(request()))).activity!;

    expect(activity).toEqual({
      orgs: { total: 7, connected: 4, paid: 2, pendingDeletion: 1 },
      logins: { last24h: 3, last7d: 5 },
      loginLinks: { requested24h: 6, used24h: 4 },
      surveys: { respondedToday: 1, responded7d: 9, awaitingEmail: 2 },
      digestSendsThisWeek: 3,
      unsubscribesTotal: 11,
    });
  });

  it('computes time windows in UTC from the request instant', async () => {
    await GET(request());

    const call = (fragment: string) => queryOneMock.mock.calls.find(([sql]) => String(sql).includes(fragment))!;
    expect(call('FROM organizations')[1]).toEqual(['2026-03-15T08:00:00.000Z', '2026-03-09T08:00:00.000Z']);
    expect(call('FROM login_tokens')[1]).toEqual(['2026-03-15T08:00:00.000Z']);
    expect(call('FROM survey_responses')[1]).toEqual(['2026-03-16T00:00:00.000Z', '2026-03-09T08:00:00.000Z']);
    expect(call('FROM digest_sends')[1]).toEqual([WEEK_OF]);
  });

});

describe('GET /api/admin/status — degraded database', () => {
  it('still answers 200 with the app and scheduler sections when the ping fails', async () => {
    queryOneMock.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT 1')) throw new Error('ECONNREFUSED');
      throw new Error(`should not have queried: ${sql}`);
    });

    const res = await GET(request());
    const json = await body(res);

    expect(res.status).toBe(200);
    expect(json.db).toEqual({ ok: false, latencyMs: null, error: 'ECONNREFUSED' });
    expect(json.pipeline).toBeNull();
    expect(json.activity).toBeNull();
    expect(json.scheduler).toEqual(SCHEDULER);
    expect(queryMock).not.toHaveBeenCalled();
    expect(queryOneMock).toHaveBeenCalledTimes(1);
  });

  it('nulls only the failing section and reports why', async () => {
    stubQueries({ surveysThrow: true });

    const json = await body(await GET(request()));

    expect(json.activity).toBeNull();
    expect(json.pipeline).not.toBeNull();
    expect(json.errors).toEqual([expect.stringMatching(/^activity: .*column "nope"/)]);
  });

  it('nulls the pipeline and names it when the cron_runs query fails', async () => {
    queryMock.mockRejectedValue(new Error('relation "cron_runs" does not exist'));

    const json = await body(await GET(request()));

    expect(json.pipeline).toBeNull();
    expect(json.activity).not.toBeNull();
    expect(json.errors).toEqual([expect.stringMatching(/^pipeline: .*cron_runs/)]);
  });

  it('reports both sections, still as 200, when every data query fails', async () => {
    queryMock.mockRejectedValue(new Error('boom'));
    stubQueries({ surveysThrow: true });

    const res = await GET(request());
    const json = await body(res);

    expect(res.status).toBe(200);
    expect(json.pipeline).toBeNull();
    expect(json.activity).toBeNull();
    expect(json.errors).toHaveLength(2);
  });

  it('nulls activity rather than zeroing it when an aggregate returns no row', async () => {
    // A healthy empty system says 0 orgs; a broken query must never look like one.
    queryOneMock.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM unsubscribes')) return null;
      if (sql.includes('SELECT 1')) return { '?column?': 1 };
      if (sql.includes('FROM organizations')) return ORGS_ROW;
      if (sql.includes('FROM login_tokens')) return LINKS_ROW;
      if (sql.includes('FROM survey_responses')) return SURVEYS_ROW;
      if (sql.includes('FROM digest_sends')) return { count: 3 };
      throw new Error(`unexpected queryOne: ${sql}`);
    });

    const json = await body(await GET(request()));

    expect(json.activity).toBeNull();
    expect(json.errors[0]).toContain('activity query returned no row');
  });
});
