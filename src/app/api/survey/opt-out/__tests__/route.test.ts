import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

// ─── Mocks ────────────────────────────────────────────────────────────────

const verifySurveyTokenMock = vi.fn();
vi.mock('@/lib/crypto', () => ({
  verifySurveyToken: (...args: unknown[]) => verifySurveyTokenMock(...args),
}));

const queryOneMock = vi.fn();
const executeMock = vi.fn();
vi.mock('@/lib/db', () => ({
  queryOne: (...args: unknown[]) => queryOneMock(...args),
  execute: (...args: unknown[]) => executeMock(...args),
}));

const checkRateLimitMock = vi.fn();
vi.mock('@/lib/ratelimit', () => ({
  checkRateLimit: (...args: unknown[]) => checkRateLimitMock(...args),
  clientIp: () => '203.0.113.1',
}));

import { GET, POST } from '../route';

const TOKEN = 'signed-survey-token';
const APP_URL = 'https://app.churnlens.com';
const ORIGINAL_APP_URL = process.env.NEXT_PUBLIC_APP_URL;

const PAYLOAD = {
  orgId: 'org-1',
  customerId: 'cus_1',
  subscriptionId: 'sub_1',
  exp: Date.now() + 1000,
};

function optOutRequest(method: 'GET' | 'POST', token: string | null = TOKEN) {
  const url = token
    ? `http://localhost/api/survey/opt-out?token=${token}`
    : 'http://localhost/api/survey/opt-out';
  return new NextRequest(url, { method });
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_APP_URL = APP_URL;

  verifySurveyTokenMock.mockReset();
  queryOneMock.mockReset();
  executeMock.mockReset();
  checkRateLimitMock.mockReset();

  verifySurveyTokenMock.mockReturnValue(PAYLOAD);
  queryOneMock.mockResolvedValue({ org_id: PAYLOAD.orgId, customer_email: 'jane@example.com' });
  executeMock.mockResolvedValue(1);
  checkRateLimitMock.mockReturnValue({ allowed: true, retryAfterSec: 0 });
});

afterEach(() => {
  if (ORIGINAL_APP_URL === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
  else process.env.NEXT_PUBLIC_APP_URL = ORIGINAL_APP_URL;
});

describe('GET /api/survey/opt-out', () => {
  it('redirects to the unsubscribed confirmation page', async () => {
    const res = await GET(optOutRequest('GET'));
    expect(res.status).toBe(307); // NextResponse.redirect default
    expect(res.headers.get('location')).toBe(`${APP_URL}/survey/unsubscribed`);
  });

  it('suppresses the customer found for the token', async () => {
    await GET(optOutRequest('GET'));

    expect(executeMock).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO unsubscribes'),
      [PAYLOAD.orgId, 'jane@example.com'],
    );
  });

  it('still redirects to the same page for a missing token, without suppressing anything', async () => {
    const res = await GET(optOutRequest('GET', null));

    expect(res.headers.get('location')).toBe(`${APP_URL}/survey/unsubscribed`);
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('still redirects to the same page for an invalid token — never leaks validity', async () => {
    verifySurveyTokenMock.mockReturnValue(null);

    const res = await GET(optOutRequest('GET', 'bad-token'));

    expect(res.headers.get('location')).toBe(`${APP_URL}/survey/unsubscribed`);
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('rate-limits by client IP', async () => {
    checkRateLimitMock.mockReturnValue({ allowed: false, retryAfterSec: 30 });

    const res = await GET(optOutRequest('GET'));

    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('30');
    expect(verifySurveyTokenMock).not.toHaveBeenCalled();
  });
});

// ─── RFC 8058 one-click POST ───────────────────────────────────────────────
// Mail providers submit a machine POST here (after seeing List-Unsubscribe +
// List-Unsubscribe-Post in the survey email — see src/lib/survey-email.ts)
// instead of a human opening the GET link in a browser.

describe('POST /api/survey/opt-out', () => {
  it('returns a plain 200, never a redirect — nothing renders this response', async () => {
    const res = await POST(optOutRequest('POST'));

    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
    expect(await res.json()).toEqual({ received: true });
  });

  it('suppresses the same customer the GET link would have', async () => {
    await POST(optOutRequest('POST'));

    expect(executeMock).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO unsubscribes'),
      [PAYLOAD.orgId, 'jane@example.com'],
    );
  });

  it('still answers 200 for a missing or invalid token — never leaks validity to the provider', async () => {
    verifySurveyTokenMock.mockReturnValue(null);

    const res = await POST(optOutRequest('POST', 'bad-token'));

    expect(res.status).toBe(200);
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('rate-limits by client IP, same as GET', async () => {
    checkRateLimitMock.mockReturnValue({ allowed: false, retryAfterSec: 15 });

    const res = await POST(optOutRequest('POST'));

    expect(res.status).toBe(429);
    expect(verifySurveyTokenMock).not.toHaveBeenCalled();
  });

  it('is a no-op suppression when no survey_responses row matches the token', async () => {
    queryOneMock.mockResolvedValue(null);

    const res = await POST(optOutRequest('POST'));

    expect(res.status).toBe(200);
    expect(executeMock).not.toHaveBeenCalled();
  });
});
