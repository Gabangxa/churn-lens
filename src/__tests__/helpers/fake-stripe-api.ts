import type StripeSdk from 'stripe';

/**
 * Test support: run the REAL Stripe SDK against a fake api.stripe.com.
 *
 * Mocking the SDK itself (hand-made `customers.retrieve` stubs and hand-made
 * error classes) only proves the route agrees with the mock. Faking the HTTP
 * transport instead keeps everything the route actually depends on genuine:
 * request building, the status-code → error-class mapping (401 →
 * StripeAuthenticationError, 403 → StripePermissionError, 429 →
 * StripeRateLimitError, network failure → StripeConnectionError), webhook
 * signature verification, and the `Stripe.errors` statics used in instanceof.
 *
 * Usage, in a test file (the factory runs before the file's own imports, so
 * it reaches this module through a dynamic import; both then share the one
 * `fakeStripeApi` instance because a test file has a single module graph):
 *
 *   vi.mock('stripe', async (importOriginal) => {
 *     const { stripeModuleOverFakeApi } = await import('@/__tests__/helpers/fake-stripe-api');
 *     return stripeModuleOverFakeApi(await importOriginal<typeof import('stripe')>());
 *   });
 *   import { fakeStripeApi, stripeJson, stripeError } from '@/__tests__/helpers/fake-stripe-api';
 */

/** One request the SDK made to the fake api.stripe.com. */
export interface FakeStripeRequest {
  method: string;
  path: string;
  /** The key from the Authorization header — which stored key the code used. */
  apiKey: string;
}

export type FakeStripeResponder = (req: FakeStripeRequest) => Response | Promise<Response>;

class FakeStripeApi {
  requests: FakeStripeRequest[] = [];
  respond: FakeStripeResponder | null = null;

  reset(respond: FakeStripeResponder): void {
    this.requests = [];
    this.respond = respond;
  }

  async fetch(url: string | URL, init?: RequestInit): Promise<Response> {
    const authorization = new Headers(init?.headers).get('authorization') ?? '';
    const req: FakeStripeRequest = {
      method: init?.method ?? 'GET',
      path: new URL(String(url)).pathname,
      apiKey: authorization.replace(/^Bearer /, ''),
    };
    this.requests.push(req);
    if (!this.respond) throw new Error('fake Stripe API has no responder — call fakeStripeApi.reset() first');
    return this.respond(req);
  }
}

export const fakeStripeApi = new FakeStripeApi();

/**
 * The `stripe` module with its default export swapped for a constructor that
 * builds a real client wired to fakeStripeApi.
 *
 * Production code does `new Stripe(key, config)` and also reads the statics
 * `Stripe.webhooks` and `Stripe.errors`. A plain function that returns a real
 * client keeps both working: `new` hands back the returned object, and the
 * prototype link forwards every static to the real class.
 */
export function stripeModuleOverFakeApi(stripeModule: { default: typeof StripeSdk }) {
  const RealStripe = stripeModule.default;
  function StripeOverFakeApi(apiKey: string, config?: StripeSdk.StripeConfig) {
    return new RealStripe(apiKey, {
      ...config,
      httpClient: RealStripe.createFetchHttpClient((url: string | URL, init?: RequestInit) =>
        fakeStripeApi.fetch(url, init),
      ),
      // The SDK retries once by default, which here only adds a backoff sleep;
      // what is under test is how our code handles the error that comes out.
      maxNetworkRetries: 0,
    });
  }
  Object.setPrototypeOf(StripeOverFakeApi, RealStripe);
  return { ...stripeModule, default: StripeOverFakeApi };
}

export function stripeJson(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'request-id': 'req_fake',
      // Real Stripe sends this on most 4xx/5xx; it keeps the SDK from retrying.
      'stripe-should-retry': 'false',
    },
  });
}

/**
 * Stripe's error envelope, e.g. stripeError(401, 'invalid_request_error', 'Expired API Key provided').
 * `fields` adds the envelope's other members — most often `code`, which is
 * what tells a 404 resource_missing apart from any other 404.
 */
export function stripeError(
  status: number,
  type: string,
  message: string,
  fields: { code?: string; param?: string } = {},
): Response {
  return stripeJson(status, { error: { type, message, ...fields } });
}
