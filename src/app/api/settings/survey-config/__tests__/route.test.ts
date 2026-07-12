import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const requireOrgIdMock = vi.fn();
vi.mock('@/lib/auth', () => ({
  requireOrgId: (...args: unknown[]) => requireOrgIdMock(...args),
}));

const queryOneMock = vi.fn();
const executeMock = vi.fn();
vi.mock('@/lib/db', () => ({
  queryOne: (...args: unknown[]) => queryOneMock(...args),
  execute: (...args: unknown[]) => executeMock(...args),
}));

import { GET, PUT } from '../route';

const ORG_ID = 'org-abc';

function authOk() {
  requireOrgIdMock.mockReturnValue({ orgId: ORG_ID });
}

function authFail() {
  const error = NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });
  requireOrgIdMock.mockReturnValue({ error });
}

function getRequest() {
  return new NextRequest('http://localhost/api/settings/survey-config');
}

function putRequest(body: unknown) {
  return new NextRequest('http://localhost/api/settings/survey-config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  requireOrgIdMock.mockReset();
  queryOneMock.mockReset();
  executeMock.mockReset();
  executeMock.mockResolvedValue(1);
});

// ─── GET ──────────────────────────────────────────────────────────────────

describe('GET /api/settings/survey-config', () => {
  it('returns 401 when unauthenticated', async () => {
    authFail();
    const res = await GET(getRequest());
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: 'Not authenticated.' });
    expect(queryOneMock).not.toHaveBeenCalled();
  });

  it('returns the normalized zero-config shape when nothing is stored', async () => {
    authOk();
    queryOneMock.mockResolvedValueOnce(null);
    const res = await GET(getRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ displayName: null, logoUrl: null, customReasons: [] });
  });

  it('returns the normalized camelCase config for a configured org', async () => {
    authOk();
    queryOneMock.mockResolvedValueOnce({
      survey_config: {
        display_name: 'Acme',
        logo_url: 'https://acme.com/logo.png',
        custom_reasons: ['Billing was confusing'],
      },
    });
    const res = await GET(getRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      displayName: 'Acme',
      logoUrl: 'https://acme.com/logo.png',
      customReasons: ['Billing was confusing'],
    });
  });

  it('is scoped by the authenticated orgId', async () => {
    authOk();
    queryOneMock.mockResolvedValueOnce(null);
    await GET(getRequest());
    expect(queryOneMock).toHaveBeenCalledWith(expect.any(String), [ORG_ID]);
  });
});

// ─── PUT ──────────────────────────────────────────────────────────────────

describe('PUT /api/settings/survey-config', () => {
  it('returns 401 when unauthenticated and persists nothing', async () => {
    authFail();
    const res = await PUT(putRequest({ displayName: 'Acme' }));
    expect(res.status).toBe(401);
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('returns 400 with field "displayName" for invalid JSON body', async () => {
    authOk();
    const res = await PUT(putRequest('{not valid json'));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.field).toBe('displayName');
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('returns 400 with field "displayName" for an over-limit display name', async () => {
    authOk();
    const res = await PUT(putRequest({ displayName: 'a'.repeat(61) }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.field).toBe('displayName');
    expect(typeof body.error).toBe('string');
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('returns 400 with field "logoUrl" for a non-https logo URL', async () => {
    authOk();
    const res = await PUT(putRequest({ logoUrl: 'http://acme.com/logo.png' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.field).toBe('logoUrl');
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('returns 400 with field "customReasons" for more than 5 raw custom reasons', async () => {
    authOk();
    const res = await PUT(putRequest({ customReasons: ['a', 'b', 'c', 'd', 'e', 'f'] }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.field).toBe('customReasons');
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('returns 200 with the normalized camelCase shape and persists the snake_case storage shape', async () => {
    authOk();
    const res = await PUT(
      putRequest({
        displayName: 'Acme',
        logoUrl: 'https://acme.com/logo.png',
        customReasons: ['Billing was confusing'],
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      displayName: 'Acme',
      logoUrl: 'https://acme.com/logo.png',
      customReasons: ['Billing was confusing'],
    });

    expect(executeMock).toHaveBeenCalledTimes(1);
    const [sql, params] = executeMock.mock.calls[0];
    expect(sql).toMatch(/UPDATE organizations SET survey_config/);
    expect(params[1]).toBe(ORG_ID);
    expect(JSON.parse(params[0])).toEqual({
      display_name: 'Acme',
      logo_url: 'https://acme.com/logo.png',
      custom_reasons: ['Billing was confusing'],
    });
  });

  it('an all-empty save reverts the org to zero-config and persists an empty config', async () => {
    authOk();
    const res = await PUT(putRequest({ displayName: '', logoUrl: '', customReasons: [] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ displayName: null, logoUrl: null, customReasons: [] });

    const [, params] = executeMock.mock.calls[0];
    expect(JSON.parse(params[0])).toEqual({ display_name: null, logo_url: null, custom_reasons: [] });
  });

  it('returns 500 and does not swallow the error when the DB write fails', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    authOk();
    executeMock.mockRejectedValueOnce(new Error('connection reset'));
    const res = await PUT(putRequest({ displayName: 'Acme' }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/Failed to save/i);
    consoleErrorSpy.mockRestore();
  });
});
