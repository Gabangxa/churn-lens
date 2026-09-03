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
