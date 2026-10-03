import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * POST /api/admin/plan — the paths that end before the database: auth and
 * input validation. What a comp does to the org's plan is pinned against a
 * real database in route.db.test.ts.
 */
const verifyCronSecretMock = vi.fn();
vi.mock('@/lib/auth', () => ({
  verifyCronSecret: (...args: unknown[]) => verifyCronSecretMock(...args),
}));

const withTransactionMock = vi.fn();
vi.mock('@/lib/db', () => ({
  withTransaction: (...args: unknown[]) => withTransactionMock(...args),
}));

import { POST } from '../route';

const ORG_ID = '11111111-1111-1111-1111-111111111111';

function request(body: unknown, auth = 'Bearer secret') {
  return new Request('http://localhost/api/admin/plan', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: auth },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  verifyCronSecretMock.mockReset().mockReturnValue(true);
  withTransactionMock.mockReset().mockImplementation(() => {
    throw new Error('this test must not reach the database');
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('POST /api/admin/plan — auth', () => {
  it('rejects a bad cron secret and writes nothing', async () => {
    verifyCronSecretMock.mockReturnValue(false);

    const res = await POST(request({ orgId: ORG_ID, plan: 'starter' }));

    expect(res.status).toBe(401);
    expect(withTransactionMock).not.toHaveBeenCalled();
  });

  it('checks auth before parsing the body', async () => {
    // An unauthenticated caller must not be able to probe body-parsing behavior.
    verifyCronSecretMock.mockReturnValue(false);

    const res = await POST(request('not json at all'));

    expect(res.status).toBe(401);
  });
});

describe('POST /api/admin/plan — validation', () => {
  it('rejects a non-JSON body', async () => {
    const res = await POST(request('{{{'));

    expect(res.status).toBe(400);
  });

  it.each([
    ['a missing orgId', { plan: 'starter' }],
    ['an empty orgId', { orgId: '', plan: 'starter' }],
    ['a non-string orgId', { orgId: 42, plan: 'starter' }],
    // Postgres raises a cast error for a malformed uuid instead of matching no
    // rows; it is an operator typo, not a server failure.
    ['an orgId that is not a uuid', { orgId: 'not-a-uuid', plan: 'starter' }],
  ])('rejects %s', async (_label, body) => {
    const res = await POST(request(body));

    expect(res.status).toBe(400);
  });

  it.each([
    ['a tier that does not exist', 'enterprise'],
    ['the unbuilt lifetime tier', 'lifetime'],
    ['wrong case', 'Starter'],
    ['a missing plan', undefined],
  ])('rejects %s before it reaches the CHECK constraint', async (_label, plan) => {
    const res = await POST(request({ orgId: ORG_ID, plan }));

    expect(res.status).toBe(400);
    // The message must name the valid values, since this is an operator tool
    // with no UI to discover them from.
    expect((await res.json()).error).toMatch(/free.*starter.*growth/);
  });
});

describe('POST /api/admin/plan — database failure', () => {
  it('answers 500 rather than throwing', async () => {
    withTransactionMock.mockReset().mockRejectedValue(new Error('connection terminated'));

    const res = await POST(request({ orgId: ORG_ID, plan: 'starter' }));

    expect(res.status).toBe(500);
  });
});
