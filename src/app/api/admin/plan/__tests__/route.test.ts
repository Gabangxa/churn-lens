import { describe, it, expect, vi, beforeEach } from 'vitest';

const verifyCronSecretMock = vi.fn();
vi.mock('@/lib/auth', () => ({
  verifyCronSecret: (...args: unknown[]) => verifyCronSecretMock(...args),
}));

const executeMock = vi.fn();
vi.mock('@/lib/db', () => ({
  execute: (...args: unknown[]) => executeMock(...args),
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

/** Params of the UPDATE the route issued. */
const updateParams = () => executeMock.mock.calls[0][1];

beforeEach(() => {
  verifyCronSecretMock.mockReset().mockReturnValue(true);
  executeMock.mockReset().mockResolvedValue(1);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('POST /api/admin/plan — auth', () => {
  it('rejects a bad cron secret and writes nothing', async () => {
    verifyCronSecretMock.mockReturnValue(false);

    const res = await POST(request({ orgId: ORG_ID, plan: 'starter' }));

    expect(res.status).toBe(401);
    expect(executeMock).not.toHaveBeenCalled();
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
    expect(executeMock).not.toHaveBeenCalled();
  });

  it.each([
    ['a missing orgId', { plan: 'starter' }],
    ['an empty orgId', { orgId: '', plan: 'starter' }],
    ['a non-string orgId', { orgId: 42, plan: 'starter' }],
  ])('rejects %s', async (_label, body) => {
    const res = await POST(request(body));

    expect(res.status).toBe(400);
    expect(executeMock).not.toHaveBeenCalled();
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
    expect(executeMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/admin/plan — writes', () => {
  it.each(['free', 'starter', 'growth'])('sets the plan to %s', async (plan) => {
    const res = await POST(request({ orgId: ORG_ID, plan }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ orgId: ORG_ID, plan });
    expect(updateParams()).toEqual([plan, ORG_ID]);
  });

  it('downgrades to free, so the route can revoke as well as grant', async () => {
    const res = await POST(request({ orgId: ORG_ID, plan: 'free' }));

    expect(res.status).toBe(200);
    expect(updateParams()[0]).toBe('free');
  });

  it('returns 404 when the org does not exist', async () => {
    executeMock.mockResolvedValue(0);

    const res = await POST(request({ orgId: ORG_ID, plan: 'starter' }));

    expect(res.status).toBe(404);
  });

  it('returns 500 rather than throwing when the orgId is not a valid uuid', async () => {
    // Postgres raises a cast error for a malformed uuid instead of matching no
    // rows, so this must be handled rather than surfacing as an unhandled throw.
    executeMock.mockRejectedValue(new Error('invalid input syntax for type uuid'));

    const res = await POST(request({ orgId: 'not-a-uuid', plan: 'starter' }));

    expect(res.status).toBe(500);
  });
});
