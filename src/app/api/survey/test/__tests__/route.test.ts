import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const assertSameOriginMock = vi.fn();
const requireOrgIdMock = vi.fn();
vi.mock('@/lib/auth', () => ({
  assertSameOrigin: (...args: unknown[]) => assertSameOriginMock(...args),
  requireOrgId: (...args: unknown[]) => requireOrgIdMock(...args),
}));

const queryOneMock = vi.fn();
const executeMock = vi.fn();
vi.mock('@/lib/db', () => ({
  queryOne: (...args: unknown[]) => queryOneMock(...args),
  execute: (...args: unknown[]) => executeMock(...args),
}));

const signSurveyTokenMock = vi.fn();
vi.mock('@/lib/crypto', () => ({
  signSurveyToken: (...args: unknown[]) => signSurveyTokenMock(...args),
}));

const checkRateLimitMock = vi.fn();
vi.mock('@/lib/ratelimit', () => ({
  checkRateLimit: (...args: unknown[]) => checkRateLimitMock(...args),
}));

const sendSurveyEmailMock = vi.fn();
vi.mock('@/lib/survey-email', () => ({
  sendSurveyEmail: (...args: unknown[]) => sendSurveyEmailMock(...args),
}));

const loadSurveyConfigMock = vi.fn();
vi.mock('@/lib/survey-config', () => ({
  loadSurveyConfig: (...args: unknown[]) => loadSurveyConfigMock(...args),
}));

import { POST } from '../route';

const ORG_ID = 'org-abc';
const APP_URL = 'https://app.churnlens.com';
const ORIGINAL_APP_URL = process.env.NEXT_PUBLIC_APP_URL;

function testSurveyRequest() {
  return new NextRequest('http://localhost/api/survey/test', { method: 'POST' });
}

beforeEach(() => {
  assertSameOriginMock.mockReset().mockReturnValue(null);
  requireOrgIdMock.mockReset().mockReturnValue({ orgId: ORG_ID });
  queryOneMock.mockReset().mockResolvedValue({ email: 'founder@example.com', name: 'Fay' });
  executeMock.mockReset().mockResolvedValue(1);
  signSurveyTokenMock.mockReset().mockReturnValue('signed.survey.token');
  checkRateLimitMock.mockReset().mockReturnValue({ allowed: true, retryAfterSec: 0 });
  sendSurveyEmailMock.mockReset().mockResolvedValue(undefined);
  loadSurveyConfigMock.mockReset().mockResolvedValue({ displayName: null, logoUrl: null, customReasons: [] });
  process.env.NEXT_PUBLIC_APP_URL = APP_URL;
});

afterEach(() => {
  if (ORIGINAL_APP_URL === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
  else process.env.NEXT_PUBLIC_APP_URL = ORIGINAL_APP_URL;
});

describe('POST /api/survey/test — guards', () => {
  it('rejects a foreign origin before auth, the rate limiter, the database, or any email', async () => {
    assertSameOriginMock.mockReturnValue(
      NextResponse.json({ error: 'Cross-site request rejected.' }, { status: 403 }),
    );

    const res = await POST(testSurveyRequest());

    expect(res.status).toBe(403);
    expect(requireOrgIdMock).not.toHaveBeenCalled();
    expect(checkRateLimitMock).not.toHaveBeenCalled();
    expect(queryOneMock).not.toHaveBeenCalled();
    expect(executeMock).not.toHaveBeenCalled();
    // A cross-site page must not be able to make the app email the founder.
    expect(sendSurveyEmailMock).not.toHaveBeenCalled();
  });

  it('returns 401 without reading or emailing anyone when unauthenticated', async () => {
    requireOrgIdMock.mockReturnValue({
      error: NextResponse.json({ error: 'Not authenticated.' }, { status: 401 }),
    });

    const res = await POST(testSurveyRequest());

    expect(res.status).toBe(401);
    expect(queryOneMock).not.toHaveBeenCalled();
    expect(sendSurveyEmailMock).not.toHaveBeenCalled();
  });

  it('sends the test survey to the org owner on file, never to a caller-supplied address', async () => {
    const res = await POST(testSurveyRequest());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, sentTo: 'founder@example.com' });
    // The recipient comes from a users lookup scoped to the session org.
    expect(queryOneMock).toHaveBeenCalledWith(expect.stringMatching(/FROM users/), [ORG_ID]);
    expect(sendSurveyEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'founder@example.com', isTest: true }),
    );
  });
});
