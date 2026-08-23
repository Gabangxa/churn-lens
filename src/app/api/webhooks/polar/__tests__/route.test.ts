import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// vi.mock factories are hoisted above the module body, and the factory
// references the error class eagerly (unlike the lazily-called mock fns), so it
// must be created inside vi.hoisted or it is still in its temporal dead zone.
const { validateEventMock, FakeVerificationError } = vi.hoisted(() => {
  class FakeVerificationError extends Error {}
  return { validateEventMock: vi.fn(), FakeVerificationError };
});

vi.mock('@polar-sh/sdk/webhooks', () => ({
  validateEvent: (...args: unknown[]) => validateEventMock(...args),
  WebhookVerificationError: FakeVerificationError,
}));

const executeMock = vi.fn();
vi.mock('@/lib/db', () => ({
  execute: (...args: unknown[]) => executeMock(...args),
}));

vi.mock('@/lib/polar', () => ({
  getPolarWebhookSecret: () => 'whsec_test',
}));

import { POST } from '../route';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const STARTER = 'prod_starter';
const GROWTH = 'prod_growth';

function request(body = '{}') {
  return new Request('http://localhost/api/webhooks/polar', {
    method: 'POST',
    headers: { 'webhook-id': 'msg_1', 'webhook-signature': 'v1,sig' },
    body,
  });
}

function subscription(over: Record<string, unknown> = {}) {
  return {
    id: 'sub_1',
    status: 'active',
    productId: STARTER,
    customerId: 'cus_1',
    createdAt: new Date('2026-08-01T00:00:00Z'),
    modifiedAt: new Date('2026-08-20T00:00:00Z'),
    customer: { id: 'cus_1', externalId: ORG_ID },
    ...over,
  };
}

function emit(type: string, over: Record<string, unknown> = {}) {
  validateEventMock.mockReturnValue({ type, data: subscription(over) });
}

/** Params of the UPDATE the route issued. */
const updateParams = () => executeMock.mock.calls[0][1];

beforeEach(() => {
  validateEventMock.mockReset();
  executeMock.mockReset().mockResolvedValue(1);
  process.env.POLAR_PRODUCT_STARTER = STARTER;
  process.env.POLAR_PRODUCT_GROWTH = GROWTH;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  delete process.env.POLAR_PRODUCT_STARTER;
  delete process.env.POLAR_PRODUCT_GROWTH;
});

describe('POST /api/webhooks/polar — signature', () => {
  it('returns 403 on a bad signature and writes nothing', async () => {
    validateEventMock.mockImplementation(() => {
      throw new FakeVerificationError('bad signature');
    });

    const res = await POST(request());

    expect(res.status).toBe(403);
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('returns 500 when the secret is missing, so Polar retries after the fix', async () => {
    validateEventMock.mockImplementation(() => {
      throw new Error('POLAR_WEBHOOK_SECRET is not set');
    });

    const res = await POST(request());

    expect(res.status).toBe(500);
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('verifies against the raw body bytes', async () => {
    emit('subscription.active');
    const body = '{"type":"subscription.active"}';

    await POST(request(body));

    const passed = validateEventMock.mock.calls[0][0];
    expect(Buffer.isBuffer(passed)).toBe(true);
    expect(passed.toString()).toBe(body);
  });
});

describe('POST /api/webhooks/polar — entitlement is driven by status, not event type', () => {
  it('grants the mapped plan on an active subscription', async () => {
    emit('subscription.active');

    const res = await POST(request());

    expect(res.status).toBe(200);
    expect(updateParams()[0]).toBe('starter');
  });

  it('grants growth for the growth product', async () => {
    emit('subscription.active', { productId: GROWTH });

    await POST(request());

    expect(updateParams()[0]).toBe('growth');
  });

  it('does NOT revoke on subscription.canceled while the status is still active', async () => {
    // The customer requested cancellation but has paid through the period end.
    // Revoking here would cut off access they are still owed — the single most
    // likely integration bug, so it is pinned explicitly.
    emit('subscription.canceled', { status: 'active' });

    await POST(request());

    expect(updateParams()[0]).toBe('starter');
  });

  it('revokes only once the status is terminal', async () => {
    emit('subscription.revoked', { status: 'canceled' });

    await POST(request());

    expect(updateParams()[0]).toBe('free');
  });

  it('keeps a past_due subscription entitled', async () => {
    emit('subscription.past_due', { status: 'past_due' });

    await POST(request());

    expect(updateParams()[0]).toBe('starter');
  });

  it('restores the plan on uncancel', async () => {
    emit('subscription.uncanceled', { status: 'active' });

    await POST(request());

    expect(updateParams()[0]).toBe('starter');
  });

  it.each(['unpaid', 'incomplete_expired', 'paused'])(
    'revokes on the terminal status %s',
    async (status) => {
      emit('subscription.updated', { status });

      await POST(request());

      expect(updateParams()[0]).toBe('free');
    },
  );

  it('leaves the plan untouched for an incomplete subscription', async () => {
    emit('subscription.created', { status: 'incomplete' });

    const res = await POST(request());

    expect(res.status).toBe(200);
    expect(executeMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/webhooks/polar — refuses to guess', () => {
  it('does not grant a plan for an unrecognized product', async () => {
    emit('subscription.active', { productId: 'prod_unknown' });

    const res = await POST(request());

    expect(res.status).toBe(200);
    expect((await res.json()).skipped).toBe('unknown_product');
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('still revokes even when the product is unknown', async () => {
    // Revocation does not depend on knowing the tier, and failing to revoke
    // would leave a non-paying org on a paid plan.
    emit('subscription.revoked', { status: 'canceled', productId: 'prod_unknown' });

    await POST(request());

    expect(updateParams()[0]).toBe('free');
  });

  it('acknowledges a subscription with no external id rather than retrying forever', async () => {
    emit('subscription.active', { customer: { id: 'cus_1', externalId: null } });

    const res = await POST(request());

    expect(res.status).toBe(200);
    expect((await res.json()).skipped).toBe('no_external_id');
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('acknowledges unhandled event types without touching the database', async () => {
    validateEventMock.mockReturnValue({ type: 'benefit.created', data: {} });

    const res = await POST(request());

    expect(res.status).toBe(200);
    expect(executeMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/webhooks/polar — out-of-order delivery', () => {
  it('guards the write with a watermark on the event timestamp', async () => {
    emit('subscription.active');

    await POST(request());

    const [sql, params] = executeMock.mock.calls[0];
    expect(sql).toMatch(/polar_synced_at IS NULL OR polar_synced_at < \$4/);
    expect(params[3]).toEqual(new Date('2026-08-20T00:00:00Z'));
  });

  it('falls back to createdAt when modifiedAt is null', async () => {
    emit('subscription.created', { modifiedAt: null });

    await POST(request());

    expect(updateParams()[3]).toEqual(new Date('2026-08-01T00:00:00Z'));
  });

  it('acknowledges a stale event that the watermark rejected', async () => {
    executeMock.mockResolvedValue(0);
    emit('subscription.updated', { status: 'active' });

    const res = await POST(request());

    expect(res.status).toBe(200);
    expect((await res.json()).skipped).toBe('stale_or_unknown_org');
  });

  it('records the Polar ids alongside the plan', async () => {
    emit('subscription.active');

    await POST(request());

    const params = updateParams();
    expect(params[1]).toBe('cus_1');
    expect(params[2]).toBe('sub_1');
    expect(params[4]).toBe(ORG_ID);
  });
});
