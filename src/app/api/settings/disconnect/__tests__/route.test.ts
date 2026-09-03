import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const assertSameOriginMock = vi.fn();
const requireOrgIdMock = vi.fn();
vi.mock('@/lib/auth', () => ({
  assertSameOrigin: (...args: unknown[]) => assertSameOriginMock(...args),
  requireOrgId: (...args: unknown[]) => requireOrgIdMock(...args),
}));

const queryMock = vi.fn();
const queryOneMock = vi.fn();
vi.mock('@/lib/db', () => ({
  query: (...args: unknown[]) => queryMock(...args),
  queryOne: (...args: unknown[]) => queryOneMock(...args),
}));

const decryptApiKeyMock = vi.fn();
vi.mock('@/lib/crypto', () => ({
  decryptApiKey: (...args: unknown[]) => decryptApiKeyMock(...args),
}));

const webhookDelMock = vi.fn();
const stripeConstructorMock = vi.fn();
vi.mock('stripe', () => {
  class MockStripe {
    webhookEndpoints = { del: (...args: unknown[]) => webhookDelMock(...args) };
    constructor(...args: unknown[]) {
      stripeConstructorMock(...args);
    }
  }
  return { default: MockStripe };
});

import { DELETE } from '../route';

const ORG_ID = 'org-abc';
const APP_URL = 'https://app.churnlens.com';
const ORIGINAL_APP_URL = process.env.NEXT_PUBLIC_APP_URL;

let errorSpy: ReturnType<typeof vi.spyOn>;

function disconnectRequest() {
  return new NextRequest('http://localhost/api/settings/disconnect', { method: 'DELETE' });
}

function authOk() {
  requireOrgIdMock.mockReturnValue({ orgId: ORG_ID });
}

function connectedOrg() {
  queryOneMock.mockResolvedValue({
    stripe_api_key_enc: 'v1.encrypted-key',
    stripe_webhook_id: 'we_churnlens',
  });
}

beforeEach(() => {
  assertSameOriginMock.mockReset().mockReturnValue(null);
  requireOrgIdMock.mockReset();
  queryMock.mockReset().mockResolvedValue([]);
  queryOneMock.mockReset();
  decryptApiKeyMock.mockReset().mockReturnValue('rk_live_decrypted');
  webhookDelMock.mockReset().mockResolvedValue({ id: 'we_churnlens', deleted: true });
  stripeConstructorMock.mockReset();
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  process.env.NEXT_PUBLIC_APP_URL = APP_URL;
  authOk();
  connectedOrg();
});

afterEach(() => {
  errorSpy.mockRestore();
  if (ORIGINAL_APP_URL === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
  else process.env.NEXT_PUBLIC_APP_URL = ORIGINAL_APP_URL;
});

describe('DELETE /api/settings/disconnect — guards', () => {
  it('rejects a foreign origin before checking auth or touching the database', async () => {
    assertSameOriginMock.mockReturnValue(
      NextResponse.json({ error: 'Cross-site request rejected.' }, { status: 403 }),
    );

    const res = await DELETE(disconnectRequest());

    expect(res.status).toBe(403);
    expect(requireOrgIdMock).not.toHaveBeenCalled();
    expect(queryOneMock).not.toHaveBeenCalled();
    expect(queryMock).not.toHaveBeenCalled();
    expect(webhookDelMock).not.toHaveBeenCalled();
  });

  it('returns 401 and wipes nothing when unauthenticated', async () => {
    requireOrgIdMock.mockReturnValue({
      error: NextResponse.json({ error: 'Not authenticated.' }, { status: 401 }),
    });

    const res = await DELETE(disconnectRequest());

    expect(res.status).toBe(401);
    expect(queryOneMock).not.toHaveBeenCalled();
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('returns 404 without writing when the org row is gone', async () => {
    queryOneMock.mockResolvedValue(null);

    const res = await DELETE(disconnectRequest());

    expect(res.status).toBe(404);
    expect(queryMock).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/settings/disconnect — the session survives', () => {
  it('does NOT clear the org cookie (disconnecting Stripe is not logging out)', async () => {
    const res = await DELETE(disconnectRequest());

    // Regression guard for the old behavior, which cleared the cookie here and
    // forced a re-login. Sessions are minted only by /api/auth/verify now, so
    // there is nothing a logged-out founder could re-derive by reconnecting.
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${APP_URL}/onboarding`);
  });
});

describe('DELETE /api/settings/disconnect — clearing the connection', () => {
  it('clears every Stripe column for the session org only', async () => {
    await DELETE(disconnectRequest());

    expect(queryOneMock).toHaveBeenCalledWith(expect.any(String), [ORG_ID]);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/UPDATE organizations/);
    for (const column of [
      'stripe_api_key_enc = NULL',
      'stripe_account_id = NULL',
      'stripe_webhook_id = NULL',
      'stripe_webhook_secret_enc = NULL',
    ]) {
      expect(sql).toContain(column);
    }
    expect(params).toEqual([ORG_ID]);
  });

  it('deletes only the webhook endpoint ChurnLens registered', async () => {
    await DELETE(disconnectRequest());

    expect(stripeConstructorMock).toHaveBeenCalledWith(
      'rk_live_decrypted',
      expect.objectContaining({ apiVersion: '2024-04-10' }),
    );
    expect(webhookDelMock).toHaveBeenCalledTimes(1);
    expect(webhookDelMock).toHaveBeenCalledWith('we_churnlens');
  });

  it.each([
    ['no stored key', { stripe_api_key_enc: null, stripe_webhook_id: 'we_orphan' }],
    ['no registered webhook', { stripe_api_key_enc: 'v1.encrypted-key', stripe_webhook_id: null }],
  ])('skips the Stripe call when the org has %s, but still clears the row', async (_label, org) => {
    queryOneMock.mockResolvedValue(org);

    const res = await DELETE(disconnectRequest());

    expect(webhookDelMock).not.toHaveBeenCalled();
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(303);
  });

  it('still clears the row when Stripe refuses to delete the endpoint', async () => {
    // A revoked key or an endpoint deleted by hand must not strand the founder
    // with a connection they cannot remove.
    webhookDelMock.mockRejectedValue(new Error('resource_missing'));

    const res = await DELETE(disconnectRequest());

    expect(res.status).toBe(303);
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalled();
  });

  it('still clears the row when the stored key cannot be decrypted', async () => {
    decryptApiKeyMock.mockImplementation(() => {
      throw new Error('bad ciphertext');
    });

    const res = await DELETE(disconnectRequest());

    expect(res.status).toBe(303);
    expect(queryMock).toHaveBeenCalledTimes(1);
  });
});
