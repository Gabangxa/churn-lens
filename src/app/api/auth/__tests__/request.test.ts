import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

    // The whole point of the account-takeover fix: requesting a link — even
    // one that creates the account — never itself mints a session. Only a
    // click on the emailed link (/api/auth/verify) can do that.
    expect(res.headers.get('set-cookie')).toBeNull();
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

describe('POST /api/auth/request — input validation', () => {
  it('rejects a malformed JSON body with 400 before any DB work', async () => {
    const req = new NextRequest('http://localhost/api/auth/request', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });

    const res = await POST(req);

    expect(res.status).toBe(400);
    expect(queryOneMock).not.toHaveBeenCalled();
    expect(withTransactionMock).not.toHaveBeenCalled();
    expect(executeMock).not.toHaveBeenCalled();
  });

  it.each([
    ['a missing email', {}],
    ['a non-string email', { email: 12345 }],
    ['an address with no @', { email: 'nope' }],
  ])('rejects %s with 400 and creates no account', async (_label, body) => {
    const res = await POST(requestBody(body));

    expect(res.status).toBe(400);
    expect(withTransactionMock).not.toHaveBeenCalled();
    expect(executeMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('drops a non-string next instead of storing or crashing on it', async () => {
    queryOneMock.mockResolvedValueOnce({ org_id: EXISTING_ORG_ID });

    const res = await POST(requestBody({ email: 'founder@example.com', next: ['/dashboard'] }));

    expect(res.status).toBe(200);
    const tokenInsert = executeMock.mock.calls.find(([sql]) => sql.includes('INSERT INTO login_tokens'));
    expect(tokenInsert![1][4]).toBeNull();
  });

  it('drops a query-string variant of an allow-listed path (exact match only)', async () => {
    queryOneMock.mockResolvedValueOnce({ org_id: EXISTING_ORG_ID });

    // /settings is allow-listed; /settings?x=1 is not the same string, and the
    // allow-list is deliberately exact so no parameter can ride along.
    await POST(requestBody({ email: 'founder@example.com', next: '/settings?x=1' }));

    const tokenInsert = executeMock.mock.calls.find(([sql]) => sql.includes('INSERT INTO login_tokens'));
    expect(tokenInsert![1][4]).toBeNull();
  });

  it.each([
    ['//evil.com'],
    ['https://evil.com'],
    ['http://localhost/dashboard'],
    ['/dashboard/../../evil'],
    ['/onboarding?plan=enterprise'],
  ])('drops the open-redirect candidate %s', async (next) => {
    queryOneMock.mockResolvedValueOnce({ org_id: EXISTING_ORG_ID });

    await POST(requestBody({ email: 'founder@example.com', next }));

    const tokenInsert = executeMock.mock.calls.find(([sql]) => sql.includes('INSERT INTO login_tokens'));
    expect(tokenInsert![1][4]).toBeNull();
  });
});

describe('POST /api/auth/request — signup transaction failure', () => {
  // Everything from the cleanup DELETE onward is wrapped in one try/catch (see
  // the route): a DB or Resend failure here has nothing to do with whether the
  // caller's email/IP is well-behaved, so it must not turn into a 500 that
  // tells an attacker "this one got further than the last one." It logs and
  // still answers { ok: true }, same as every other path through this route.
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('logs and still answers ok when the signup transaction fails for a reason other than a race', async () => {
    // withTransaction rolls back and rethrows (see lib/db.test.ts for the
    // BEGIN/ROLLBACK proof). A plain failure (not a unique-violation race) is
    // not recoverable — no token should be issued for an org that was never
    // committed — but it also must not surface to the caller as anything other
    // than the same { ok: true } every other path returns.
    withTransactionMock.mockRejectedValue(new Error('insert failed'));

    const res = await POST(requestBody({ email: 'new-founder@example.com' }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const tokenInsert = executeMock.mock.calls.find(([sql]) => sql.includes('INSERT INTO login_tokens'));
    expect(tokenInsert).toBeUndefined();
    expect(sendMock).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
  });

  it('re-selects the racing row and still issues a token on a unique-violation (concurrent first signup)', async () => {
    // Two requests for the same never-seen-before email can both read "no
    // existing user" and both start a transaction; only one wins the
    // users_email_lower_key unique index (scripts/migrate.js), and the loser's
    // INSERT fails with Postgres error code 23505 after rolling back. That is
    // not a real failure — the account exists, just not from this call's own
    // transaction — so this re-selects it and carries on rather than losing
    // the founder's login link to a double-click.
    const uniqueViolation = Object.assign(new Error('duplicate key value'), { code: '23505' });
    withTransactionMock.mockRejectedValue(uniqueViolation);
    queryOneMock
      .mockResolvedValueOnce(null) // first lookup: no existing user yet
      .mockResolvedValueOnce({ org_id: EXISTING_ORG_ID }); // re-select after losing the race

    const res = await POST(requestBody({ email: 'racing-founder@example.com' }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const tokenInserts = executeMock.mock.calls.filter(([sql]) => sql.includes('INSERT INTO login_tokens'));
    expect(tokenInserts).toHaveLength(1); // exactly one token, not one per race participant
    expect(tokenInserts[0][1][1]).toBe(EXISTING_ORG_ID); // org_id param — the winner's org
    expect(sendMock).toHaveBeenCalledTimes(1);
    // Not the "something went wrong" path — a race isn't an error.
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('logs and still answers ok when re-selecting after a unique-violation somehow finds no row', async () => {
    const uniqueViolation = Object.assign(new Error('duplicate key value'), { code: '23505' });
    withTransactionMock.mockRejectedValue(uniqueViolation);
    queryOneMock
      .mockResolvedValueOnce(null) // first lookup: no existing user
      .mockResolvedValueOnce(null); // re-select still finds nothing — not the race we assumed

    const res = await POST(requestBody({ email: 'founder@example.com' }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(sendMock).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
  });

  it('logs and still answers ok when the token insert fails', async () => {
    queryOneMock.mockResolvedValueOnce({ org_id: EXISTING_ORG_ID });
    executeMock.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO login_tokens')) throw new Error('token insert failed');
      return 1;
    });

    const res = await POST(requestBody({ email: 'founder@example.com' }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    // A link whose token was never stored can only end in "expired" — it must
    // not reach the inbox and burn the per-email rate-limit budget.
    expect(sendMock).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
  });
});

describe('POST /api/auth/request — global signup rate limit', () => {
  it('creates no account and answers ok when the global signup bucket is exhausted', async () => {
    queryOneMock.mockResolvedValueOnce(null); // no existing user — this is a signup attempt
    checkRateLimitMock.mockImplementation((key: string) =>
      key === 'signup' ? { allowed: false, retryAfterSec: 600 } : { allowed: true, retryAfterSec: 0 },
    );

    const res = await POST(requestBody({ email: 'mass-signup@example.com' }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(withTransactionMock).not.toHaveBeenCalled();
    const tokenInsert = executeMock.mock.calls.find(([sql]) => sql.includes('INSERT INTO login_tokens'));
    expect(tokenInsert).toBeUndefined();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('does not consult the signup bucket at all for a returning user (login, not signup)', async () => {
    queryOneMock.mockResolvedValueOnce({ org_id: EXISTING_ORG_ID });

    await POST(requestBody({ email: 'returning@example.com' }));

    expect(checkRateLimitMock).not.toHaveBeenCalledWith('signup', expect.anything(), expect.anything());
  });

  it('checks the signup bucket by a fixed global key, not per-IP or per-email', async () => {
    queryOneMock.mockResolvedValueOnce(null);

    await POST(requestBody({ email: 'new-founder@example.com' }));

    expect(checkRateLimitMock).toHaveBeenCalledWith('signup', 30, 600_000);
  });
});

describe('POST /api/auth/request — email delivery failures stay invisible to the caller', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('still answers ok when Resend reports an error object rather than throwing', async () => {
    // Resend resolves with { data: null, error } — swallowing that silently
    // would log a failed send as a delivered login link.
    sendMock.mockResolvedValue({ data: null, error: { name: 'validation_error', message: 'bad' } });
    queryOneMock.mockResolvedValueOnce({ org_id: EXISTING_ORG_ID });

    const res = await POST(requestBody({ email: 'founder@example.com' }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(errorSpy).toHaveBeenCalled();
  });

  it('still answers ok when the send throws outright', async () => {
    sendMock.mockRejectedValue(new Error('network down'));
    queryOneMock.mockResolvedValueOnce({ org_id: EXISTING_ORG_ID });

    const res = await POST(requestBody({ email: 'founder@example.com' }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
