import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const assertSameOriginMock = vi.fn();
const requireOrgIdMock = vi.fn();
vi.mock('@/lib/auth', () => ({
  assertSameOrigin: (...args: unknown[]) => assertSameOriginMock(...args),
  requireOrgId: (...args: unknown[]) => requireOrgIdMock(...args),
}));

const signSurveyTokenMock = vi.fn();
vi.mock('@/lib/crypto', () => ({
  signSurveyToken: (...args: unknown[]) => signSurveyTokenMock(...args),
}));

// The preview route must never reach the database; a mock that throws makes a
// future edit that adds a query fail loudly here.
vi.mock('@/lib/db', () => {
  const forbidden = () => {
    throw new Error('the preview route must not touch the database');
  };
  return { query: forbidden, queryOne: forbidden, execute: forbidden, queryCount: forbidden };
});

import { GET } from '../route';

const ORG_ID = 'org-abc';
const APP_URL = 'https://app.churnlens.com';
const ORIGINAL_APP_URL = process.env.NEXT_PUBLIC_APP_URL;

function previewRequest() {
  return new NextRequest('http://localhost/api/survey/preview');
}

beforeEach(() => {
  assertSameOriginMock.mockReset().mockReturnValue(null);
  requireOrgIdMock.mockReset().mockReturnValue({ orgId: ORG_ID });
  signSurveyTokenMock.mockReset().mockReturnValue('signed.preview.token');
  process.env.NEXT_PUBLIC_APP_URL = APP_URL;
});

afterEach(() => {
  if (ORIGINAL_APP_URL === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
  else process.env.NEXT_PUBLIC_APP_URL = ORIGINAL_APP_URL;
});

describe('GET /api/survey/preview — guards', () => {
  it('rejects a foreign origin before auth or minting a token', async () => {
    assertSameOriginMock.mockReturnValue(
      NextResponse.json({ error: 'Cross-site request rejected.' }, { status: 403 }),
    );

    const res = await GET(previewRequest());

    expect(res.status).toBe(403);
    expect(requireOrgIdMock).not.toHaveBeenCalled();
    // The token carries the org id; a cross-site page must not be able to mint one.
    expect(signSurveyTokenMock).not.toHaveBeenCalled();
  });

  it('sends an unauthenticated visitor to /login, not /onboarding', async () => {
    // Onboarding requires a session too now, so bouncing there was a redirect
    // loop for anyone without one.
    requireOrgIdMock.mockReturnValue({
      error: NextResponse.json({ error: 'Not authenticated.' }, { status: 401 }),
    });

    const res = await GET(previewRequest());

    expect(res.headers.get('location')).toBe(`${APP_URL}/login`);
    expect(signSurveyTokenMock).not.toHaveBeenCalled();
  });

  it('mints a preview token scoped to the session org and redirects to the survey', async () => {
    const res = await GET(previewRequest());

    expect(signSurveyTokenMock).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: ORG_ID, kind: 'preview' }),
    );
    expect(res.headers.get('location')).toBe(`${APP_URL}/survey/signed.preview.token`);
  });
});
