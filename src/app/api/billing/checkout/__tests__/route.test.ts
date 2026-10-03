import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * GET /api/billing/checkout when Polar misbehaves. The real Polar SDK talks to
 * a fake api.polar.sh, so the deadline under test is the SDK's own.
 */
const requireOrgIdMock = vi.fn();
vi.mock('@/lib/auth', () => ({
  assertSameOrigin: () => null,
  requireOrgId: (...args: unknown[]) => requireOrgIdMock(...args),
}));

vi.mock('@/lib/db', () => ({
  queryOne: async () => ({ email: 'founder@acme.example' }),
}));

vi.mock('@polar-sh/sdk', async (importOriginal) => {
  const { polarModuleOverFakeApi } = await import('@/__tests__/helpers/fake-polar-api');
  return polarModuleOverFakeApi(await importOriginal<typeof import('@polar-sh/sdk')>());
});

import { GET } from '../route';
import { fakePolarApi, hangUntilAborted } from '@/__tests__/helpers/fake-polar-api';
// Real: ALERT_EMAIL is pinned empty for every suite (vitest.config.ts).
import { getErrorReportSnapshot, resetErrorReports } from '@/lib/report-error';

const ORG_ID = '7d4c1a52-3f0e-4b8a-9c61-2e5f8a9b0c13';

function checkoutRequest(plan = 'starter') {
  return new NextRequest(`http://localhost/api/billing/checkout?plan=${plan}`);
}

beforeEach(() => {
  requireOrgIdMock.mockReset().mockResolvedValue({ orgId: ORG_ID });
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.churnlens.test');
  vi.stubEnv('POLAR_ACCESS_TOKEN', 'polar_oat_test');
  vi.stubEnv('POLAR_PRODUCT_STARTER', 'prod_starter');
  resetErrorReports();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('GET /api/billing/checkout — a Polar that never answers', () => {
  it('gives up after 10 seconds and answers 502 instead of holding the founder’s tab open', async () => {
    // The SDK arms its deadline with AbortSignal.timeout, on Node's internal
    // timers where fake timers cannot reach, so time is made to pass at once:
    // the deadline is already expired, and the fake Polar hangs until it
    // fires. Without timeoutMs on the call this test hangs until vitest kills it.
    const deadlines: number[] = [];
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      deadlines.push(ms);
      return AbortSignal.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
    });
    fakePolarApi.reset((_req, signal) => hangUntilAborted(signal));

    const res = await GET(checkoutRequest());

    expect(res.status).toBe(502);
    expect(fakePolarApi.requests.map((r) => `${r.method} ${r.path}`)).toEqual(['POST /v1/checkouts/']);
    expect(deadlines).toEqual([10_000]);
    expect(getErrorReportSnapshot().recent).toEqual([
      expect.objectContaining({ context: 'billing.checkout', meta: { orgId: ORG_ID, plan: 'starter' } }),
    ]);
  });
});
