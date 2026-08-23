import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// ─── Mocks ────────────────────────────────────────────────────────────────
// No Postgres, no Resend, no Stripe API in this environment: every boundary
// the route touches is stubbed.

const queryOneMock = vi.fn();
const queryCountMock = vi.fn();
const executeMock = vi.fn();
vi.mock('@/lib/db', () => ({
  queryOne: (...args: unknown[]) => queryOneMock(...args),
  queryCount: (...args: unknown[]) => queryCountMock(...args),
  execute: (...args: unknown[]) => executeMock(...args),
}));

const FRESH_TOKEN = 'freshly-signed-token';
const STORED_TOKEN = 'token-already-on-the-row';

vi.mock('@/lib/crypto', () => ({
  decryptApiKey: (enc: string) => `decrypted:${enc}`,
  signSurveyToken: () => FRESH_TOKEN,
}));

const sendSurveyEmailMock = vi.fn();
vi.mock('@/lib/survey-email', () => ({
  sendSurveyEmail: (...args: unknown[]) => sendSurveyEmailMock(...args),
}));

vi.mock('@/lib/survey-config', () => ({
  loadSurveyConfig: async () => ({ displayName: null, logoUrl: null, customReasons: [] }),
}));

const constructEventMock = vi.fn();
const customersRetrieveMock = vi.fn();
vi.mock('stripe', () => {
  class MockStripe {
    customers = { retrieve: (...args: unknown[]) => customersRetrieveMock(...args) };
    static webhooks = { constructEvent: (...args: unknown[]) => constructEventMock(...args) };
  }
  return { default: MockStripe };
});

import { POST } from '../[orgId]/route';

// ─── Fixtures ─────────────────────────────────────────────────────────────

const ORG_ID = 'org-1';
const SUB_ID = 'sub_123';
const CUSTOMER_EMAIL = 'customer@example.com';
const APP_URL = 'https://app.churnlens.com';

const ORIGINAL_APP_URL = process.env.NEXT_PUBLIC_APP_URL;

interface ItemOpts {
  interval?: string | null;
  intervalCount?: number;
  quantity?: number | null;
  omitQuantity?: boolean;
}

/** One subscription line item in the shape the webhook payload delivers. */
function item(unitAmount: number | null, opts: ItemOpts = {}) {
  const { interval = 'month', intervalCount = 1, quantity = 1, omitQuantity } = opts;
  const built: Record<string, unknown> = {
    price: {
      unit_amount: unitAmount,
      recurring: interval === null ? null : { interval, interval_count: intervalCount },
    },
  };
  if (!omitQuantity) built.quantity = quantity;
  return built;
}

function deletedEvent(opts: { items?: unknown[]; cancellationDetails?: unknown } = {}) {
  return {
    type: 'customer.subscription.deleted',
    data: {
      object: {
        id: SUB_ID,
        customer: 'cus_1',
        items: { data: opts.items ?? [item(2900)] },
        cancellation_details: opts.cancellationDetails ?? null,
      },
    },
  };
}

function orgRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ORG_ID,
    plan: 'growth',
    stripe_api_key_enc: 'enc-api-key',
    stripe_webhook_secret_enc: 'enc-webhook-secret',
    ...overrides,
  };
}

/**
 * A row as the classification SELECT returns it. That SELECT runs only after the
 * claim UPDATE has already refused the send, and it decides the response body
 * (duplicate vs exhausted) — never whether to send.
 */
function existingRow(overrides: Record<string, unknown> = {}) {
  return {
    surveyed_at: null,
    survey_email_sent_at: null,
    survey_email_attempts: 1,
    is_test: false,
    ...overrides,
  };
}

function webhookRequest(signature: string | null = 'sig_test') {
  const headers: Record<string, string> = {};
  if (signature !== null) headers['stripe-signature'] = signature;
  return new NextRequest(`http://localhost/api/webhooks/stripe/${ORG_ID}`, {
    method: 'POST',
    headers,
    body: '{"raw":"body"}',
  });
}

function callPost(signature: string | null = 'sig_test') {
  return POST(webhookRequest(signature), { params: { orgId: ORG_ID } });
}

/** The params of the idempotent INSERT — [orgId, email, name, subId, mrrLost, token]. */
function insertParams(): unknown[] {
  return executeMock.mock.calls[0][1] as unknown[];
}

/** Runs one cancellation through the route and returns the mrr_lost the INSERT wrote. */
async function mrrLostFor(items: unknown[]): Promise<number> {
  constructEventMock.mockReturnValue(deletedEvent({ items }));
  const res = await callPost();
  expect(res.status).toBe(200);
  return insertParams()[4] as number;
}

let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  process.env.NEXT_PUBLIC_APP_URL = APP_URL;

  queryOneMock.mockReset();
  queryCountMock.mockReset();
  executeMock.mockReset();
  sendSurveyEmailMock.mockReset();
  constructEventMock.mockReset();
  customersRetrieveMock.mockReset();

  // Happy path: known org, not free tier, not unsubscribed, INSERT wins, send OK.
  queryOneMock.mockResolvedValue(orgRow());
  queryCountMock.mockResolvedValue(0);
  executeMock.mockResolvedValue(1);
  sendSurveyEmailMock.mockResolvedValue(undefined);
  customersRetrieveMock.mockResolvedValue({ deleted: false, email: CUSTOMER_EMAIL, name: 'Jane' });
  constructEventMock.mockReturnValue(deletedEvent());

  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
  consoleWarnSpy.mockRestore();
  if (ORIGINAL_APP_URL === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
  else process.env.NEXT_PUBLIC_APP_URL = ORIGINAL_APP_URL;
});

// ─── MRR normalization ────────────────────────────────────────────────────
// monthlyCentsForItem is module-local (Next 14 rejects extra route.ts exports),
// so the arithmetic is exercised through POST and read off the INSERT's
// mrr_lost parameter — which is the value customers actually see.

describe('mrr_lost normalization', () => {
  it('records a $50/month plan as 50', async () => {
    expect(await mrrLostFor([item(5000)])).toBe(50);
  });

  it('records a $1200/year plan as 100, not 1200 (the 12x annual bug)', async () => {
    expect(await mrrLostFor([item(120000, { interval: 'year' })])).toBe(100);
  });

  it('multiplies by quantity: 5 seats of a $50/month plan is 250, not 50', async () => {
    expect(await mrrLostFor([item(5000, { quantity: 5 })])).toBe(250);
  });

  it('divides by interval_count: $300 billed every 3 months is 100', async () => {
    expect(await mrrLostFor([item(30000, { intervalCount: 3 })])).toBe(100);
  });

  it('divides by interval_count on annual too: $1200 billed every 2 years is 50', async () => {
    expect(await mrrLostFor([item(120000, { interval: 'year', intervalCount: 2 })])).toBe(50);
  });

  it('combines interval and quantity: 3 seats of a $348/year plan is 87', async () => {
    expect(await mrrLostFor([item(34800, { interval: 'year', quantity: 3 })])).toBe(87);
  });

  it('normalizes a weekly plan with the 52-week calendar average', async () => {
    // 1000c/week * 52 / 12 = 4333.33c = $43.33 -> 43
    expect(await mrrLostFor([item(1000, { interval: 'week' })])).toBe(43);
  });

  it('normalizes a daily plan with the 365-day calendar average', async () => {
    // 100c/day * 365 / 12 = 3041.67c = $30.42 -> 30
    expect(await mrrLostFor([item(100, { interval: 'day' })])).toBe(30);
  });

  it('sums every line item, not just items.data[0]', async () => {
    // $29/month base + $348/year add-on = 29 + 29
    expect(await mrrLostFor([item(2900), item(34800, { interval: 'year' })])).toBe(58);
  });

  it('rounds once at the end, not per item', async () => {
    // Two items of $10.50 = $21 exactly. Rounding each first would give 11+11=22.
    expect(await mrrLostFor([item(1050), item(1050)])).toBe(21);
  });

  it('rounds a single half-dollar amount to the nearest dollar', async () => {
    expect(await mrrLostFor([item(2950)])).toBe(30);
  });

  it('contributes 0 for a tiered/metered price with unit_amount null, without NaN', async () => {
    const mrr = await mrrLostFor([item(null, { interval: 'year', quantity: 4 })]);
    expect(mrr).toBe(0);
    expect(Number.isNaN(mrr)).toBe(false);
  });

  it('still counts the priced items when one item is tiered', async () => {
    expect(await mrrLostFor([item(null), item(5000)])).toBe(50);
  });

  it('records 0 for a subscription with no line items', async () => {
    expect(await mrrLostFor([])).toBe(0);
  });

  it('falls back to monthly (and warns) for an unrecognized interval', async () => {
    const mrr = await mrrLostFor([item(5000, { interval: 'fortnight' })]);
    expect(mrr).toBe(50);
    expect(Number.isNaN(mrr)).toBe(false);
    expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
    expect(String(consoleWarnSpy.mock.calls[0][0])).toMatch(/fortnight/);
  });

  it('falls back to monthly (and warns) when the price has no recurring block', async () => {
    expect(await mrrLostFor([item(5000, { interval: null })])).toBe(50);
    expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
  });

  it('treats interval_count 0 as 1 rather than producing Infinity', async () => {
    const mrr = await mrrLostFor([item(2900, { intervalCount: 0 })]);
    expect(mrr).toBe(29);
    expect(Number.isFinite(mrr)).toBe(true);
  });

  it('treats a missing quantity and a null quantity both as 1', async () => {
    expect(await mrrLostFor([item(5000, { omitQuantity: true })])).toBe(50);
    executeMock.mockClear();
    expect(await mrrLostFor([item(5000, { quantity: null })])).toBe(50);
  });
});

// ─── First send ───────────────────────────────────────────────────────────

describe('first delivery of a cancellation', () => {
  it('sends the survey and stamps survey_email_sent_at', async () => {
    const res = await callPost();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
    expect(sendSurveyEmailMock).toHaveBeenCalledTimes(1);

    expect(executeMock).toHaveBeenCalledTimes(2);
    const [sql, params] = executeMock.mock.calls[1];
    expect(sql).toMatch(/UPDATE survey_responses/);
    expect(sql).toMatch(/survey_email_sent_at\s*=\s*now\(\)/);
    expect(params).toEqual([SUB_ID, ORG_ID]);
  });

  it('claims the send in the INSERT, before the email goes out', async () => {
    // The attempt is consumed up front so a send that never returns at all
    // (provider stall, platform timeout killing the request) still burns one.
    // Counting it afterwards leaves the cap permanently at 0 for that failure
    // mode, and leaves the row looking unclaimed to a concurrent delivery.
    await callPost();

    const [sql] = executeMock.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO survey_responses/);
    expect(sql).toMatch(/survey_email_attempts/);
    expect(sql).toMatch(/survey_email_last_attempt_at/);
    expect(sql).toMatch(/VALUES\s*\([^)]*\b1,\s*now\(\)\)/);
  });

  it('does not increment the attempt counter again after a successful send', async () => {
    await callPost();

    const [sentAtSql] = executeMock.mock.calls[1];
    expect(sentAtSql).not.toMatch(/survey_email_attempts/);
  });

  it('emails the token it just signed and stored on the new row', async () => {
    await callPost();

    expect(insertParams()[5]).toBe(FRESH_TOKEN);
    const opts = sendSurveyEmailMock.mock.calls[0][0];
    expect(opts.surveyUrl).toBe(`${APP_URL}/survey/${FRESH_TOKEN}`);
    expect(opts.optOutUrl).toBe(`${APP_URL}/api/survey/opt-out?token=${FRESH_TOKEN}`);
    expect(opts.to).toBe(CUSTOMER_EMAIL);
  });
});

// ─── Send failure ─────────────────────────────────────────────────────────

describe('when the survey email fails to send', () => {
  beforeEach(() => {
    sendSurveyEmailMock.mockRejectedValue(new Error('resend 502'));
  });

  it('returns 500 so Stripe retries', async () => {
    const res = await callPost();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Survey email send failed' });
  });

  it('does NOT stamp survey_email_sent_at', async () => {
    await callPost();

    // Only the claiming INSERT ran. The attempt was already counted there, so
    // the failure path has no bookkeeping of its own to get wrong — and nothing
    // marks the row delivered.
    expect(executeMock).toHaveBeenCalledTimes(1);
    const [sql] = executeMock.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO survey_responses/);
    expect(sql).not.toMatch(/survey_email_sent_at/);
  });

  it('logs the org id and subscription id so the stranded row is findable', async () => {
    await callPost();
    const logged = consoleErrorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain(ORG_ID);
    expect(logged).toContain(SUB_ID);
  });

  it('needs no write after the failure — the attempt is already on the row', async () => {
    // This is what makes the cap survive a send that dies without returning:
    // the request can be killed anywhere after the INSERT and the attempt still
    // counted. A post-failure UPDATE would simply never run in that case.
    await callPost();

    expect(executeMock).toHaveBeenCalledTimes(1);
  });
});

// ─── Retry against an existing row ────────────────────────────────────────

describe('Stripe retry that hits the idempotency guard', () => {
  /**
   * INSERT conflicts, then the conditional claim UPDATE returns `claim`
   * (a row means we won the send; null means we did not). When the claim is
   * refused, `existing` is what the follow-up classification SELECT returns.
   */
  function retryWith(
    claim: { token: string } | null,
    existing: Record<string, unknown> | null = null,
  ) {
    executeMock.mockReset();
    executeMock.mockResolvedValueOnce(0); // INSERT ... ON CONFLICT DO NOTHING
    executeMock.mockResolvedValue(1); // any subsequent UPDATE
    queryOneMock.mockReset();
    queryOneMock.mockResolvedValueOnce(orgRow()); // org lookup
    queryOneMock.mockResolvedValueOnce(claim); // claim UPDATE ... RETURNING token
    if (claim === null) queryOneMock.mockResolvedValueOnce(existing); // classification
  }

  /** The claim UPDATE, as [sql, params]. */
  function claimCall(): [string, unknown[]] {
    return queryOneMock.mock.calls[1] as [string, unknown[]];
  }

  const wonClaim = { token: STORED_TOKEN };

  it('re-sends a stranded row instead of reporting a duplicate', async () => {
    retryWith(wonClaim);

    const res = await callPost();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
    expect(sendSurveyEmailMock).toHaveBeenCalledTimes(1);
  });

  it('re-sends using the token RETURNED BY THE CLAIM, never a freshly signed one', async () => {
    retryWith(wonClaim);

    await callPost();

    const opts = sendSurveyEmailMock.mock.calls[0][0];
    expect(opts.surveyUrl).toBe(`${APP_URL}/survey/${STORED_TOKEN}`);
    expect(opts.optOutUrl).toBe(`${APP_URL}/api/survey/opt-out?token=${STORED_TOKEN}`);
    // The freshly signed token matches no row, so it must not reach the customer.
    expect(opts.surveyUrl).not.toContain(FRESH_TOKEN);
    expect(opts.optOutUrl).not.toContain(FRESH_TOKEN);
  });

  it('stamps survey_email_sent_at after a successful re-send, without re-counting the attempt', async () => {
    retryWith(wonClaim);

    await callPost();

    const updates = executeMock.mock.calls.slice(1);
    expect(updates).toHaveLength(1);
    expect(updates[0][0]).toMatch(/survey_email_sent_at\s*=\s*now\(\)/);
    expect(updates[0][0]).not.toMatch(/survey_email_attempts/);
  });

  // ── the claim itself ────────────────────────────────────────────────────
  // Every reason a row must not be re-sent lives in this one statement's WHERE
  // clause. Reading the row and then deciding — the shape this replaced — lets
  // two overlapping deliveries both observe the pre-send state and both email
  // the customer, because survey_email_sent_at is only written AFTER the send.

  it('decides the send with a single conditional UPDATE, not a read-then-act', async () => {
    retryWith(wonClaim);

    await callPost();

    const [sql, params] = claimCall();
    expect(sql).toMatch(/^\s*UPDATE survey_responses/);
    expect(sql).toMatch(/RETURNING token/);
    expect(params[0]).toBe(SUB_ID);
    expect(params[1]).toBe(ORG_ID);
  });

  it.each([
    ['the customer already answered', /surveyed_at IS NULL/],
    ['an email already went out', /survey_email_sent_at IS NULL/],
    ['test rows belong to /api/survey/test', /NOT is_test/],
    ['no token means no working link', /token IS NOT NULL/],
    ['the attempt cap', /survey_email_attempts < \$3/],
    ['a sibling delivery holds the claim', /survey_email_last_attempt_at/],
  ])('refuses the claim in SQL when %s', async (_reason, pattern) => {
    retryWith(wonClaim);

    await callPost();

    expect(claimCall()[0]).toMatch(pattern);
  });

  it('consumes the attempt in the claim, before the email is sent', async () => {
    retryWith(wonClaim);

    await callPost();

    const [sql] = claimCall();
    expect(sql).toMatch(/survey_email_attempts\s*=\s*survey_email_attempts\s*\+\s*1/);
    expect(sql).toMatch(/survey_email_last_attempt_at\s*=\s*now\(\)/);
  });

  it('passes the attempt cap and the claim cooldown as parameters', async () => {
    retryWith(wonClaim);

    await callPost();

    const [, params] = claimCall();
    expect(params[2]).toBe(5); // MAX_SURVEY_EMAIL_ATTEMPTS
    // Long enough to outlive a request the platform killed mid-send, short
    // enough to be well inside Stripe's first retry interval.
    expect(params[3]).toBeGreaterThanOrEqual(10);
    expect(params[3]).toBeLessThan(3600);
  });

  // ── losing the claim ────────────────────────────────────────────────────

  it('sends nothing when a concurrent delivery already holds the claim', async () => {
    // THE race: Stripe delivers the same event twice at once. The first is
    // inside sendSurveyEmail, so the row still reads surveyed_at NULL,
    // survey_email_sent_at NULL, attempts under the cap — every marker of a
    // stranded row. Only the claim tells them apart, and this delivery lost it.
    retryWith(null, existingRow({ survey_email_attempts: 1 }));

    const res = await callPost();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, skipped: 'duplicate_event' });
    expect(sendSurveyEmailMock).not.toHaveBeenCalled();
  });

  it.each([
    ['the email already went out', existingRow({ survey_email_sent_at: '2026-08-01T00:00:00Z' })],
    ['the customer already answered', existingRow({ surveyed_at: '2026-08-02T00:00:00Z' })],
    [
      'the row was portal-prefilled (surveyed_at set, sent_at NULL)',
      existingRow({ surveyed_at: '2026-08-02T00:00:00Z', survey_email_sent_at: null }),
    ],
    ['it is a test row', existingRow({ is_test: true })],
    ['the subscription belongs to another org', null],
  ])('reports a duplicate when %s', async (_reason, existing) => {
    retryWith(null, existing);

    const res = await callPost();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, skipped: 'duplicate_event' });
    expect(sendSurveyEmailMock).not.toHaveBeenCalled();
  });

  it('scopes the classification lookup to this subscription and org', async () => {
    retryWith(null, existingRow());

    await callPost();

    expect(queryOneMock).toHaveBeenCalledTimes(3);
    const [sql, params] = queryOneMock.mock.calls[2];
    expect(sql).toMatch(/FROM survey_responses/);
    expect(params).toEqual([SUB_ID, ORG_ID]);
  });

  it('gives up with 200 and an exhausted reason at the cap so Stripe stops retrying', async () => {
    retryWith(null, existingRow({ survey_email_attempts: 5 }));

    const res = await callPost();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, skipped: 'email_send_exhausted' });
    expect(sendSurveyEmailMock).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalled();
    const logged = consoleErrorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain(SUB_ID);
  });

  it('stays exhausted past the cap', async () => {
    retryWith(null, existingRow({ survey_email_attempts: 9 }));

    const res = await callPost();

    expect(await res.json()).toEqual({ received: true, skipped: 'email_send_exhausted' });
    expect(sendSurveyEmailMock).not.toHaveBeenCalled();
  });

  it('reports a plain duplicate, not exhaustion, once the email did go out', async () => {
    // A delivered row that happens to be past the cap is not a stranded send.
    retryWith(
      null,
      existingRow({ survey_email_attempts: 9, survey_email_sent_at: '2026-08-01T00:00:00Z' }),
    );

    expect(await (await callPost()).json()).toEqual({
      received: true,
      skipped: 'duplicate_event',
    });
  });
});

// ─── Bookkeeping failure after a successful send ──────────────────────────

describe('when the sent_at UPDATE fails after the email is out', () => {
  it('returns 200 anyway — a 5xx would mail the customer twice', async () => {
    executeMock.mockReset();
    executeMock.mockResolvedValueOnce(1); // INSERT
    executeMock.mockRejectedValueOnce(new Error('connection reset')); // sent_at UPDATE

    const res = await callPost();

    expect(sendSurveyEmailMock).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
    expect(consoleErrorSpy).toHaveBeenCalled();
  });
});

// ─── Portal-prefilled cancellations ───────────────────────────────────────

describe('portal feedback prefill', () => {
  const cancellationDetails = { feedback: 'too_expensive', comment: 'Too pricey', reason: null };

  it('records the answer, sends no email, and leaves survey_email_sent_at unset', async () => {
    constructEventMock.mockReturnValue(deletedEvent({ cancellationDetails }));

    const res = await callPost();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, prefilled: 'portal_feedback' });
    expect(sendSurveyEmailMock).not.toHaveBeenCalled();

    // One INSERT, no follow-up UPDATE: nothing stamps sent_at, truthfully.
    expect(executeMock).toHaveBeenCalledTimes(1);
    const [sql] = executeMock.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO survey_responses/);
    expect(sql).not.toMatch(/survey_email_sent_at/);
  });

  it('reports a duplicate when the prefill INSERT conflicts', async () => {
    constructEventMock.mockReturnValue(deletedEvent({ cancellationDetails }));
    executeMock.mockReset();
    executeMock.mockResolvedValue(0);

    const res = await callPost();

    expect(await res.json()).toEqual({ received: true, skipped: 'duplicate_event' });
    expect(sendSurveyEmailMock).not.toHaveBeenCalled();
  });

  it('normalizes MRR on the prefill path too', async () => {
    constructEventMock.mockReturnValue(
      deletedEvent({ cancellationDetails, items: [item(120000, { interval: 'year' })] }),
    );

    await callPost();

    expect(insertParams()[4]).toBe(100);
  });
});

// ─── Guards that must keep working ────────────────────────────────────────

describe('pre-send guards', () => {
  it('rejects a request with no stripe-signature', async () => {
    const res = await callPost(null);
    expect(res.status).toBe(400);
    expect(sendSurveyEmailMock).not.toHaveBeenCalled();
  });

  it('rejects an unknown org', async () => {
    queryOneMock.mockReset();
    queryOneMock.mockResolvedValue(null);
    const res = await callPost();
    expect(res.status).toBe(404);
  });

  it('rejects a bad signature and writes nothing', async () => {
    constructEventMock.mockImplementation(() => {
      throw new Error('no signatures found matching the expected signature');
    });
    const res = await callPost();
    expect(res.status).toBe(400);
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('ignores event types other than customer.subscription.deleted', async () => {
    constructEventMock.mockReturnValue({ type: 'invoice.paid', data: { object: {} } });
    const res = await callPost();
    expect(await res.json()).toEqual({ received: true });
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('skips a customer who previously opted out', async () => {
    queryCountMock.mockReset();
    queryCountMock.mockResolvedValue(1); // unsubscribes hit
    const res = await callPost();
    expect(await res.json()).toEqual({ received: true, skipped: 'unsubscribed' });
    expect(sendSurveyEmailMock).not.toHaveBeenCalled();
  });

  it('skips once a free org has hit its monthly cap', async () => {
    queryOneMock.mockReset();
    queryOneMock.mockResolvedValue(orgRow({ plan: 'free' }));
    queryCountMock.mockReset();
    queryCountMock.mockResolvedValueOnce(10); // free-tier count
    const res = await callPost();
    expect(await res.json()).toEqual({ received: true, skipped: 'free_tier_limit' });
    expect(sendSurveyEmailMock).not.toHaveBeenCalled();
  });
});

// ─── Migration ────────────────────────────────────────────────────────────
// The webhook SELECTs and UPDATEs survey_email_sent_at / survey_email_attempts;
// without these columns every one of those queries raises 42703. There is no
// Postgres here, so the contract is asserted against the migration source.

describe('scripts/migrate.js survey-email bookkeeping columns', () => {
  const source = readFileSync(resolve(__dirname, '../../../../../../scripts/migrate.js'), 'utf8');

  it('adds the three survey-email bookkeeping columns to survey_responses', () => {
    expect(source).toMatch(
      /ALTER TABLE survey_responses\s+ADD COLUMN IF NOT EXISTS survey_email_sent_at timestamptz,\s+ADD COLUMN IF NOT EXISTS survey_email_attempts integer NOT NULL DEFAULT 0,\s+ADD COLUMN IF NOT EXISTS survey_email_last_attempt_at timestamptz;/,
    );
  });

  it('leaves survey_email_last_attempt_at nullable — rows written before it exist', () => {
    // The claim UPDATE's cooldown check is `IS NULL OR older than the cooldown`,
    // so a NULL on a backfilled row must mean "claimable", not "blocked".
    expect(source).not.toMatch(/survey_email_last_attempt_at timestamptz NOT NULL/);
  });

  it('is additive and re-runnable — every ADD COLUMN uses IF NOT EXISTS', () => {
    // Strip // comments first; the file discusses ADD COLUMN in prose.
    const code = source.replace(/^\s*\/\/.*$/gm, '');
    const addColumns = code.match(/ADD COLUMN(?! IF NOT EXISTS)/g) ?? [];
    expect(addColumns).toEqual([]);
  });

  it('defaults survey_email_attempts to 0 so pre-existing rows are re-sendable', () => {
    // A NULL default would make `survey_email_attempts < 5` NULL for every
    // backfilled row, silently disabling the retry path.
    expect(source).toMatch(/survey_email_attempts integer NOT NULL DEFAULT 0/);
  });

  it('leaves survey_email_sent_at nullable — NULL is what marks a row stranded', () => {
    expect(source).not.toMatch(/survey_email_sent_at timestamptz NOT NULL/);
  });

  it('creates survey_responses before altering it', () => {
    const create = source.indexOf('CREATE TABLE IF NOT EXISTS survey_responses');
    const alter = source.indexOf('ADD COLUMN IF NOT EXISTS survey_email_sent_at');
    expect(create).toBeGreaterThan(-1);
    expect(alter).toBeGreaterThan(create);
  });
});
