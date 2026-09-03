import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ────────────────────────────────────────────────────────────────

const queryMock = vi.fn();
const queryOneMock = vi.fn();
vi.mock('@/lib/db', () => ({
  query: (...args: unknown[]) => queryMock(...args),
  queryOne: (...args: unknown[]) => queryOneMock(...args),
}));

vi.mock('@/lib/crypto', () => ({
  decryptApiKey: (enc: string) => `decrypted:${enc}`,
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

import { disconnectStripe } from '../stripe-disconnect';

const ORG_ID = 'org-1';

/** The org row as the SELECT returns it: connected, with a registered endpoint. */
function orgRow(overrides: Record<string, unknown> = {}) {
  return {
    stripe_api_key_enc: 'enc-api-key',
    stripe_webhook_id: 'we_123',
    ...overrides,
  };
}

/** The credential-clearing UPDATE, normalized for matching. */
function clearingUpdate(): { sql: string; params: unknown[] } | null {
  const call = queryMock.mock.calls.find(([sql]) => /UPDATE organizations/.test(String(sql)));
  if (!call) return null;
  return { sql: String(call[0]).replace(/\s+/g, ' ').trim(), params: call[1] as unknown[] };
}

beforeEach(() => {
  queryMock.mockReset();
  queryOneMock.mockReset();
  webhookDelMock.mockReset();
  stripeConstructorMock.mockReset();

  queryOneMock.mockResolvedValue(orgRow());
  queryMock.mockResolvedValue([]);
  webhookDelMock.mockResolvedValue({ deleted: true });

  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('disconnectStripe', () => {
  it('deletes the endpoint ChurnLens registered, using the org’s own decrypted key', async () => {
    await disconnectStripe(ORG_ID);

    expect(stripeConstructorMock).toHaveBeenCalledWith(
      'decrypted:enc-api-key',
      expect.objectContaining({ apiVersion: '2024-04-10' }),
    );
    expect(webhookDelMock).toHaveBeenCalledWith('we_123');
    // Exactly one endpoint, the stored one — never a list-and-delete sweep that
    // could take out a webhook the customer created for something else.
    expect(webhookDelMock).toHaveBeenCalledTimes(1);
  });

  it('clears every stored Stripe credential column for that org', async () => {
    await disconnectStripe(ORG_ID);

    const update = clearingUpdate();
    expect(update).not.toBeNull();
    expect(update!.sql).toBe(
      'UPDATE organizations SET stripe_api_key_enc = NULL, stripe_account_id = NULL, ' +
        'stripe_webhook_id = NULL, stripe_webhook_secret_enc = NULL WHERE id = $1',
    );
    expect(update!.params).toEqual([ORG_ID]);
  });

  it('still clears the credentials when Stripe refuses the endpoint delete', async () => {
    // This is what makes the purge job's hard-delete reachable: a dead or
    // rotated key must not leave the org row (and its personal data) alive
    // forever because Stripe's own cleanup failed.
    webhookDelMock.mockRejectedValue(new Error('No such webhook endpoint'));

    await expect(disconnectStripe(ORG_ID)).resolves.toBeUndefined();

    expect(clearingUpdate()).not.toBeNull();
  });

  it('logs the org id when the endpoint delete fails, so it can be cleaned up by hand', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    webhookDelMock.mockRejectedValue(new Error('No such webhook endpoint'));

    await disconnectStripe(ORG_ID);

    const logged = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain(ORG_ID);
  });

  it('skips Stripe entirely when no API key is stored', async () => {
    queryOneMock.mockResolvedValue(orgRow({ stripe_api_key_enc: null }));

    await disconnectStripe(ORG_ID);

    expect(stripeConstructorMock).not.toHaveBeenCalled();
    expect(webhookDelMock).not.toHaveBeenCalled();
    expect(clearingUpdate()).not.toBeNull();
  });

  it('skips Stripe entirely when no webhook endpoint was ever registered', async () => {
    queryOneMock.mockResolvedValue(orgRow({ stripe_webhook_id: null }));

    await disconnectStripe(ORG_ID);

    expect(webhookDelMock).not.toHaveBeenCalled();
    expect(clearingUpdate()).not.toBeNull();
  });

  it('is a no-op-but-safe call when the org row is already gone', async () => {
    queryOneMock.mockResolvedValue(null);

    await expect(disconnectStripe(ORG_ID)).resolves.toBeUndefined();

    expect(webhookDelMock).not.toHaveBeenCalled();
    // The UPDATE still runs and affects zero rows — cheaper than a second
    // existence check, and both callers treat it the same way.
    expect(clearingUpdate()).not.toBeNull();
  });

  it('propagates a failure of the credential-clearing UPDATE', async () => {
    // The caller has to know: "disconnected" that left the key in the database
    // is not disconnected, and the purge job must not delete the org row while
    // believing its Stripe teardown ran.
    queryMock.mockRejectedValue(new Error('db down'));

    await expect(disconnectStripe(ORG_ID)).rejects.toThrow('db down');
  });
});
