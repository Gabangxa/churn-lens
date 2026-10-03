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

const loadSurveyPresentationMock = vi.fn();
vi.mock('@/lib/survey-config', () => ({
  loadSurveyPresentation: (...args: unknown[]) => loadSurveyPresentationMock(...args),
}));

import { POST } from '../route';
// Real: these tests assert on what the route reported. ALERT_EMAIL is pinned
// empty for every suite (vitest.config.ts), so nothing is emailed.
import { getErrorReportSnapshot, resetErrorReports } from '@/lib/report-error';

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
  loadSurveyPresentationMock
    .mockReset()
    .mockResolvedValue({ displayName: null, logoUrl: null, customReasons: [], businessName: null });
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

  it('names the business exactly as a real survey would, Stripe-name fallback included', async () => {
    // A test send that named "the founder" while real customers got "Acme"
    // would show the founder something their customers never see.
    loadSurveyPresentationMock.mockResolvedValue({
      displayName: null,
      logoUrl: null,
      customReasons: [],
      businessName: 'Acme From Stripe',
    });

    await POST(testSurveyRequest());

    expect(loadSurveyPresentationMock).toHaveBeenCalledWith(ORG_ID);
    expect(sendSurveyEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({ displayName: 'Acme From Stripe' }),
    );
  });

  it('records the name the email carried, with the sent stamp, for the survey page to repeat', async () => {
    loadSurveyPresentationMock.mockResolvedValue({
      displayName: null,
      logoUrl: null,
      customReasons: [],
      businessName: 'Acme From Stripe',
    });

    await POST(testSurveyRequest());

    const stamp = executeMock.mock.calls.find(([sql]) => /survey_email_sent_at = now\(\)/.test(sql as string));
    expect(stamp?.[0]).toMatch(/business_name = \$3/);
    expect(stamp?.[1]).toEqual([expect.stringMatching(/^test_/), ORG_ID, 'Acme From Stripe']);
  });
});

describe('POST /api/survey/test — error reporting', () => {
  beforeEach(() => {
    resetErrorReports();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports a failed test send with the org id, never the founder's address", async () => {
    // The same send path real cancellations take, so a failure here is an
    // early warning for theirs. Resend errors can quote the recipient.
    sendSurveyEmailMock.mockRejectedValue(new Error('Invalid to field: founder@example.com'));

    const res = await POST(testSurveyRequest());

    expect(res.status).toBe(500);
    const { recent } = getErrorReportSnapshot();
    expect(recent).toEqual([
      expect.objectContaining({ context: 'survey.test', meta: { orgId: ORG_ID } }),
    ]);
    expect(JSON.stringify(recent)).not.toContain('founder@example.com');
  });

  it('reports a sent test whose survey_email_sent_at stamp failed, and still answers success', async () => {
    executeMock.mockResolvedValueOnce(1); // INSERT
    executeMock.mockRejectedValueOnce(new Error('connection reset')); // stamp

    const res = await POST(testSurveyRequest());

    expect(res.status).toBe(200);
    expect(getErrorReportSnapshot().recent).toEqual([
      expect.objectContaining({
        context: 'survey.test',
        meta: expect.objectContaining({ orgId: ORG_ID, step: 'mark_sent' }),
      }),
    ]);
  });

  it('does not report a rate-limited test send', async () => {
    checkRateLimitMock.mockReturnValue({ allowed: false, retryAfterSec: 60 });

    await POST(testSurveyRequest());

    expect(getErrorReportSnapshot().totalReported).toBe(0);
  });
});
