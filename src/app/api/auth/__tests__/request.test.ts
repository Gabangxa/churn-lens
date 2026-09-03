import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const assertSameOriginMock = vi.fn();
vi.mock('@/lib/auth', () => ({
  assertSameOrigin: (...args: unknown[]) => assertSameOriginMock(...args),
}));

const checkRateLimitMock = vi.fn();
const clientIpMock = vi.fn();
vi.mock('@/lib/ratelimit', () => ({
  checkRateLimit: (...args: unknown[]) => checkRateLimitMock(...args),
  clientIp: (...args: unknown[]) => clientIpMock(...args),
}));

const queryOneMock = vi.fn();
const executeMock = vi.fn();
// The fake connection handed to the withTransaction callback. Its `query`
// stands in for a real pg client inside BEGIN/COMMIT: the route never touches
// the pool-backed helpers while inside the transaction.
const clientQueryMock = vi.fn();
const withTransactionMock = vi.fn();
vi.mock('@/lib/db', () => ({
  queryOne: (...args: unknown[]) => queryOneMock(...args),
  execute: (...args: unknown[]) => executeMock(...args),
  withTransaction: (...args: unknown[]) => withTransactionMock(...args),
}));

const generateLoginTokenMock = vi.fn();
vi.mock('@/lib/crypto', () => ({
  generateLoginToken: (...args: unknown[]) => generateLoginTokenMock(...args),
}));

const sendMock = vi.fn();
vi.mock('@/lib/resend', () => ({
  getResend: () => ({ emails: { send: (...args: unknown[]) => sendMock(...args) } }),
  FROM_EMAIL: 'digest@churnlens.com',
}));

import { POST } from '../request/route';

const NEW_ORG_ID = 'org-new';
const EXISTING_ORG_ID = 'org-existing';

function requestBody(body: unknown) {
  return new NextRequest('http://localhost/api/auth/request', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  assertSameOriginMock.mockReset().mockReturnValue(null);
  checkRateLimitMock.mockReset().mockReturnValue({ allowed: true, retryAfterSec: 0 });
  clientIpMock.mockReset().mockReturnValue('203.0.113.1');
  queryOneMock.mockReset().mockResolvedValue(null);
  executeMock.mockReset().mockResolvedValue(1);
  clientQueryMock.mockReset().mockImplementation(async (sql: string) => {
    if (sql.includes('INSERT INTO organizations')) return { rows: [{ id: NEW_ORG_ID }] };
    return { rows: [] };
  });
  withTransactionMock.mockReset().mockImplementation(
    async (fn: (client: { query: typeof clientQueryMock }) => unknown) => fn({ query: clientQueryMock }),
  );
  generateLoginTokenMock.mockReset().mockReturnValue({ token: 'raw-token', tokenHash: 'hashed-token' });
  sendMock.mockReset().mockResolvedValue({ data: { id: 'email-1' }, error: null });
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.churnlens.com';
});

describe('POST /api/auth/request — CSRF', () => {
  it('rejects a foreign Origin before touching the database or rate limiter', async () => {
    const csrfResponse = NextResponse.json({ error: 'Cross-site request rejected.' }, { status: 403 });
    assertSameOriginMock.mockReturnValue(csrfResponse);

    const res = await POST(requestBody({ email: 'victim@example.com' }));

    expect(res.status).toBe(403);
    expect(checkRateLimitMock).not.toHaveBeenCalled();
    expect(queryOneMock).not.toHaveBeenCalled();
    expect(withTransactionMock).not.toHaveBeenCalled();
    expect(executeMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/auth/request — signup vs login', () => {
  it('creates an org and an owner user in a transaction for an email with no account, then sends a link', async () => {
    queryOneMock.mockResolvedValueOnce(null); // no existing user

    const res = await POST(requestBody({ email: 'new-founder@example.com' }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    expect(withTransactionMock).toHaveBeenCalledTimes(1);
    // Org created first...
    const orgCall = clientQueryMock.mock.calls.find(([sql]) => sql.includes('INSERT INTO organizations'));
    expect(orgCall).toBeDefined();
    expect(orgCall![1]).toEqual(expect.arrayContaining(['My Organization']));
    // ...then the owner user, scoped to that new org id.
    const userCall = clientQueryMock.mock.calls.find(([sql]) => sql.includes('INSERT INTO users'));
    expect(userCall).toBeDefined();
    expect(userCall![1]).toEqual([NEW_ORG_ID, 'new-founder@example.com']);

    // The login token issued afterward belongs to the newly created org.
    const tokenInsert = executeMock.mock.calls.find(([sql]) => sql.includes('INSERT INTO login_tokens'));
    expect(tokenInsert).toBeDefined();
    expect(tokenInsert![1][1]).toBe(NEW_ORG_ID); // org_id param

    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'new-founder@example.com', subject: 'Your ChurnLens login link' }),
    );
  });

  it('reuses the existing org for a known email and never opens a transaction', async () => {
    queryOneMock.mockResolvedValueOnce({ org_id: EXISTING_ORG_ID });

    const res = await POST(requestBody({ email: 'returning@example.com' }));

    expect(res.status).toBe(200);
    expect(withTransactionMock).not.toHaveBeenCalled();

    const tokenInsert = executeMock.mock.calls.find(([sql]) => sql.includes('INSERT INTO login_tokens'));
    expect(tokenInsert![1][1]).toBe(EXISTING_ORG_ID);
  });

  it('normalizes email (trim + lowercase) before lookup, storage, and sending', async () => {
    queryOneMock.mockResolvedValueOnce({ org_id: EXISTING_ORG_ID });

    await POST(requestBody({ email: '  Founder@Example.COM  ' }));

    expect(queryOneMock).toHaveBeenCalledWith(expect.any(String), ['founder@example.com']);
    const tokenInsert = executeMock.mock.calls.find(([sql]) => sql.includes('INSERT INTO login_tokens'));
    expect(tokenInsert![1][2]).toBe('founder@example.com'); // email param
    expect(sendMock).toHaveBeenCalledWith(expect.objectContaining({ to: 'founder@example.com' }));
  });

  it('is enumeration-safe and always answers { ok: true }, even for an unknown email', async () => {
    queryOneMock.mockResolvedValueOnce(null);
    const res = await POST(requestBody({ email: 'anyone@example.com' }));
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe('POST /api/auth/request — next/redirect_to validation', () => {
  it.each([
    ['/dashboard'],
    ['/settings'],
    ['/onboarding'],
    ['/onboarding?plan=starter'],
    ['/onboarding?plan=growth'],
  ])('stores an allow-listed next value %s as redirect_to', async (next) => {
    queryOneMock.mockResolvedValueOnce({ org_id: EXISTING_ORG_ID });

    await POST(requestBody({ email: 'founder@example.com', next }));

    const tokenInsert = executeMock.mock.calls.find(([sql]) => sql.includes('INSERT INTO login_tokens'));
    expect(tokenInsert![1][4]).toBe(next); // redirect_to param
  });

  it.each([
    ['an absolute URL', 'https://evil.example/'],
    ['a protocol-relative URL', '//evil.example'],
    ['an unlisted path', '/settings/danger-zone'],
    ['an unlisted plan value', '/onboarding?plan=enterprise'],
    ['garbage', 'not-a-path-at-all'],
  ])('silently drops %s rather than storing it', async (_label, next) => {
    queryOneMock.mockResolvedValueOnce({ org_id: EXISTING_ORG_ID });

    const res = await POST(requestBody({ email: 'founder@example.com', next }));

    expect(res.status).toBe(200); // never rejects the request outright
    const tokenInsert = executeMock.mock.calls.find(([sql]) => sql.includes('INSERT INTO login_tokens'));
    expect(tokenInsert![1][4]).toBeNull();
  });

  it('omits redirect_to (stores null) when next is absent', async () => {
    queryOneMock.mockResolvedValueOnce({ org_id: EXISTING_ORG_ID });
    await POST(requestBody({ email: 'founder@example.com' }));
    const tokenInsert = executeMock.mock.calls.find(([sql]) => sql.includes('INSERT INTO login_tokens'));
    expect(tokenInsert![1][4]).toBeNull();
  });
});

describe('POST /api/auth/request — rate limiting', () => {
  it('skips all DB work and email when the per-email limit is breached, but still answers ok', async () => {
    checkRateLimitMock.mockImplementation((key: string) =>
      key.startsWith('login-email:')
        ? { allowed: false, retryAfterSec: 900 }
        : { allowed: true, retryAfterSec: 0 },
    );

    const res = await POST(requestBody({ email: 'hammered@example.com' }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(queryOneMock).not.toHaveBeenCalled();
    expect(withTransactionMock).not.toHaveBeenCalled();
    expect(executeMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('returns 429 when the per-IP limit is breached', async () => {
    checkRateLimitMock.mockImplementation((key: string) =>
      key.startsWith('login-ip:')
        ? { allowed: false, retryAfterSec: 60 }
        : { allowed: true, retryAfterSec: 0 },
    );

    const res = await POST(requestBody({ email: 'anyone@example.com' }));

    expect(res.status).toBe(429);
    expect(queryOneMock).not.toHaveBeenCalled();
  });
});
