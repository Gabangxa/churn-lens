import { createHmac, randomUUID } from 'crypto';

/**
 * Test support: Polar subscriptions in Polar's own wire format (snake_case).
 *
 * The same object is what Polar puts in a subscription webhook's `data` and in
 * each item of GET /v1/subscriptions/, so one builder serves the webhook suites
 * (signed deliveries the real validateEvent verifies) and the fake Polar API
 * (list responses the real SDK schema-parses). It carries every field the SDK's
 * inbound Subscription schema requires; values no caller reads are fixed
 * placeholders, and none of them is personal data.
 */

export interface PolarSubscriptionSpec {
  id: string;
  status: string;
  productId: string;
  /** The customer's external_id — organizations.id when created by our checkout. */
  externalId: string | null;
  /** ISO string, so a test can carry Polar's microsecond precision. */
  createdAt: string;
  /** ISO string or null, as on a subscription that has never been modified. */
  modifiedAt: string | null;
  customerId?: string;
}

export function polarSubscriptionJson(spec: PolarSubscriptionSpec): Record<string, unknown> {
  const customerId = spec.customerId ?? 'cus_fixture';
  return {
    created_at: spec.createdAt,
    modified_at: spec.modifiedAt,
    id: spec.id,
    amount: 1900,
    currency: 'usd',
    recurring_interval: 'month',
    recurring_interval_count: 1,
    status: spec.status,
    current_period_start: spec.createdAt,
    current_period_end: '2026-12-31T00:00:00Z',
    current_meter_period_start: null,
    current_meter_period_end: null,
    trial_start: null,
    trial_end: null,
    cancel_at_period_end: false,
    canceled_at: null,
    started_at: spec.createdAt,
    ends_at: null,
    ended_at: null,
    pause_at_period_end: false,
    paused_at: null,
    resumes_at: null,
    customer_id: customerId,
    product_id: spec.productId,
    discount_id: null,
    checkout_id: null,
    customer_cancellation_reason: null,
    customer_cancellation_comment: null,
    metadata: {},
    customer: {
      id: customerId,
      created_at: '2026-01-01T00:00:00Z',
      modified_at: null,
      metadata: {},
      external_id: spec.externalId,
      email_verified: false,
      type: 'individual',
      name: null,
      billing_name: null,
      billing_address: null,
      tax_id: null,
      organization_id: 'polar_org_fixture',
      deleted_at: null,
      avatar_url: 'https://example.com/avatar.png',
    },
    product: {
      id: spec.productId,
      created_at: '2026-01-01T00:00:00Z',
      modified_at: null,
      trial_interval: null,
      trial_interval_count: null,
      name: 'Plan',
      description: null,
      visibility: 'public',
      recurring_interval: 'month',
      recurring_interval_count: 1,
      meter_interval: 'month',
      meter_interval_count: 1,
      is_recurring: true,
      is_archived: false,
      organization_id: 'polar_org_fixture',
      metadata: {},
      prices: [],
      benefits: [],
      medias: [],
      attached_custom_fields: [],
    },
    discount: null,
    prices: [],
    meters: [],
    pending_update: null,
  };
}

/** A webhook body: `{ type, timestamp, data }`, serialized exactly once. */
export function polarEventBody(type: string, data: unknown, timestamp = '2026-08-01T00:00:00Z'): string {
  return JSON.stringify({ type, timestamp, data });
}

/**
 * A delivery signed the way Polar signs it (Standard Webhooks, v1):
 * base64(HMAC-SHA256(key, "<webhook-id>.<webhook-timestamp>.<body>")).
 *
 * The key is the secret's raw UTF-8 bytes. The SDK's validateEvent
 * base64-encodes the configured secret before handing it to standard-webhooks,
 * which decodes it again, so that is what a correct signature must use.
 */
export function signedPolarDelivery(body: string, secret: string): Request {
  const id = `msg_${randomUUID()}`;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', Buffer.from(secret, 'utf-8'))
    .update(`${id}.${timestamp}.${body}`)
    .digest('base64');
  return new Request('http://localhost/api/webhooks/polar', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'webhook-id': id,
      'webhook-timestamp': timestamp,
      'webhook-signature': `v1,${signature}`,
    },
    body,
  });
}
