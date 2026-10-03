import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  polarEventBody,
  polarSubscriptionJson,
  signedPolarDelivery,
} from '@/__tests__/helpers/polar-fixtures';

/**
 * The Polar webhook's paths that end before the database: signature and
 * configuration failures, and payloads it cannot attribute to an org. The
 * signature is real (the SDK's validateEvent over a correctly signed body);
 * what each delivery does to the plan is pinned against a real database in
 * route.db.test.ts.
 *
 * Every test here must leave the database alone, so the db module throws
 * unless a test says otherwise.
 */
const withTransactionMock = vi.fn();
vi.mock('@/lib/db', () => ({
  withTransaction: (...args: unknown[]) => withTransactionMock(...args),
}));

import { POST } from '../route';
// Real: these tests assert on what the route reported. ALERT_EMAIL is pinned
// empty for every suite (vitest.config.ts), so nothing is emailed.
import { getErrorReportSnapshot, resetErrorReports } from '@/lib/report-error';

const SECRET = 'polar_whs_unit_secret';
const ORG_ID = '11111111-1111-1111-1111-111111111111';
const STARTER = 'prod_starter';

function subscriptionEvent(
  type: string,
  over: Partial<Parameters<typeof polarSubscriptionJson>[0]> = {},
): string {
  return polarEventBody(
    type,
    polarSubscriptionJson({
      id: 'sub_1',
      status: 'active',
      productId: STARTER,
      externalId: ORG_ID,
      createdAt: '2026-08-01T00:00:00Z',
      modifiedAt: '2026-08-20T00:00:00Z',
      ...over,
    }),
  );
}

async function post(body: string, secret = SECRET) {
  const res = await POST(signedPolarDelivery(body, secret));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  withTransactionMock.mockReset().mockImplementation(() => {
    throw new Error('this test must not reach the database');
  });
  vi.stubEnv('POLAR_WEBHOOK_SECRET', SECRET);
  vi.stubEnv('POLAR_PRODUCT_STARTER', STARTER);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  resetErrorReports();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('POST /api/webhooks/polar — a body that never arrives', () => {
  it('answers 400 and reports nothing when the sender hangs up mid-body', async () => {
    // What undici's body read throws when the client aborts. Escaping the
    // handler, it would reach withErrorReporting and alert the operator.
    const aborted = new ReadableStream({
      start(controller) {
        controller.error(new Error('aborted'));
      },
    });
    const req = new Request('http://localhost/api/webhooks/polar', {
      method: 'POST',
      body: aborted,
      duplex: 'half',
    } as RequestInit);

    const res = await POST(req);

    expect(res.status).toBe(400);
    expect(withTransactionMock).not.toHaveBeenCalled();
    expect(getErrorReportSnapshot().totalReported).toBe(0);
  });
});

describe('POST /api/webhooks/polar — signature and configuration', () => {
  it('returns 403 on a bad signature, writes nothing and reports nothing — anyone can send one', async () => {
    const res = await post(subscriptionEvent('subscription.active'), 'polar_whs_wrong');

    expect(res.status).toBe(403);
    expect(withTransactionMock).not.toHaveBeenCalled();
    expect(getErrorReportSnapshot().totalReported).toBe(0);
  });

  it('answers 500 and reports a body signed with our secret that is not JSON', async () => {
    // Only someone holding the secret can produce this, so it is not noise.
    const res = await post('this is not json');

    expect(res).toEqual({ status: 500, body: { error: 'Could not verify the event' } });
    expect(withTransactionMock).not.toHaveBeenCalled();
    expect(getErrorReportSnapshot().recent).toEqual([
      expect.objectContaining({ context: 'webhook.polar', meta: { step: 'validate' } }),
    ]);
  });

  it('verifies against the raw body bytes, not a re-serialization of them', async () => {
    // Whitespace JSON.stringify would never produce: re-serializing before
    // verifying would change the bytes and fail the signature.
    const body = '{ "type" : "customer.brand_new_thing",\n  "data" : {} }';

    const res = await post(body);

    expect(res).toEqual({ status: 200, body: { received: true, skipped: 'unparsed_event' } });
  });
});

describe('POST /api/webhooks/polar — Polar webhooks not configured', () => {
  // Billing is not live in every environment (README, deploy step 2), and this
  // URL is public. It used to report and answer 500 for any POST at all, so a
  // stranger could fill the operator's inbox. Now it is the same answer as an
  // unconfigured checkout: 503, nothing reported.

  // A fresh module per test: the warning is once per process, so a test that
  // ran first would otherwise have used it up.
  let freshPOST: typeof POST;
  beforeEach(async () => {
    vi.resetModules();
    freshPOST = (await import('../route')).POST;
    vi.stubEnv('POLAR_WEBHOOK_SECRET', '');
  });

  function polarWarnings(): unknown[][] {
    return vi.mocked(console.warn).mock.calls.filter((args) => String(args[0]).includes('POLAR_WEBHOOK_SECRET'));
  }

  it('answers 503 to a signed delivery, writes nothing and reports nothing', async () => {
    const res = await freshPOST(signedPolarDelivery(subscriptionEvent('subscription.active'), SECRET));

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Polar webhooks not configured' });
    expect(withTransactionMock).not.toHaveBeenCalled();
    expect(getErrorReportSnapshot().totalReported).toBe(0);
  });

  it('answers 503 to an anonymous POST with no signature headers, reporting nothing', async () => {
    const res = await freshPOST(
      new Request('http://localhost/api/webhooks/polar', { method: 'POST', body: '{"type":"anything"}' }),
    );

    expect(res.status).toBe(503);
    expect(getErrorReportSnapshot().totalReported).toBe(0);
  });

  it('warns once per process, not once per request', async () => {
    await freshPOST(signedPolarDelivery(subscriptionEvent('subscription.active'), SECRET));
    await freshPOST(signedPolarDelivery(subscriptionEvent('subscription.revoked'), SECRET));

    expect(polarWarnings()).toHaveLength(1);
  });
});

describe('POST /api/webhooks/polar — payloads that cannot be applied', () => {
  it('acknowledges an incomplete subscription without touching the database', async () => {
    const res = await post(subscriptionEvent('subscription.created', { status: 'incomplete' }));

    expect(res).toEqual({ status: 200, body: { received: true, skipped: 'status_incomplete' } });
  });

  it('acknowledges and reports a subscription event missing a field the plan needs', async () => {
    const data = polarSubscriptionJson({
      id: 'sub_1', status: 'active', productId: STARTER, externalId: ORG_ID,
      createdAt: '2026-08-01T00:00:00Z', modifiedAt: 'yesterday',
    });

    const res = await post(polarEventBody('subscription.cycled', data));

    expect(res).toEqual({ status: 200, body: { received: true, skipped: 'malformed_event' } });
    expect(getErrorReportSnapshot().recent).toEqual([
      expect.objectContaining({
        context: 'webhook.polar',
        meta: { subscriptionId: 'sub_1', step: 'malformed_event' },
      }),
    ]);
  });

  it.each([
    ['an email', 'someone@example.com'],
    ['an arbitrary string', 'acme-customer-42'],
    ['a uuid with trailing text', `${ORG_ID}x`],
  ])('acknowledges an external_id that is %s without passing it to Postgres', async (_label, externalId) => {
    const res = await post(subscriptionEvent('subscription.active', { externalId }));

    expect(res).toEqual({ status: 200, body: { received: true, skipped: 'bad_external_id' } });
    expect(getErrorReportSnapshot().recent[0].meta).toEqual({ subscriptionId: 'sub_1', step: 'bad_external_id' });
  });
});

describe('POST /api/webhooks/polar — database failure', () => {
  it('answers 500 so Polar retries, and reports with ids', async () => {
    withTransactionMock.mockReset().mockRejectedValue(new Error('connection terminated'));

    const res = await post(subscriptionEvent('subscription.active'));

    expect(res.status).toBe(500);
    expect(getErrorReportSnapshot().recent).toEqual([
      expect.objectContaining({
        context: 'webhook.polar',
        message: 'connection terminated',
        meta: { orgId: ORG_ID, subscriptionId: 'sub_1', step: 'apply' },
      }),
    ]);
  });
});
