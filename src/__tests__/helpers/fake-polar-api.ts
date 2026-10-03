import type * as PolarSdkModule from '@polar-sh/sdk';
import { HTTPClient } from '@polar-sh/sdk/lib/http.js';

/**
 * Test support: run the REAL Polar SDK against a fake api.polar.sh.
 *
 * The same idea as fake-stripe-api.ts. Mocking `getPolar()` with hand-made
 * `subscriptions.revoke` stubs only proves the route agrees with the stub.
 * Faking the transport keeps everything the route depends on genuine: request
 * building (paths, query encoding), response schema parsing, the status-code →
 * error-class mapping (403 → AlreadyCanceledSubscription, 404 →
 * ResourceNotFound, anything else → PolarError), pagination, and the SDK's own
 * per-request timeout.
 *
 * The SDK takes a custom transport as `new Polar({ httpClient })`, and an
 * HTTPClient takes a `fetcher`; production code calls `new Polar(...)` without
 * one, so the module's Polar class is swapped for a subclass that adds it.
 *
 * Usage, in a test file (the factory runs before the file's own imports, so it
 * reaches this module through a dynamic import; both then share the one
 * `fakePolarApi` instance because a test file has a single module graph):
 *
 *   vi.mock('@polar-sh/sdk', async (importOriginal) => {
 *     const { polarModuleOverFakeApi } = await import('@/__tests__/helpers/fake-polar-api');
 *     return polarModuleOverFakeApi(await importOriginal<typeof import('@polar-sh/sdk')>());
 *   });
 *   import { fakePolarApi, polarJson, polarApiError } from '@/__tests__/helpers/fake-polar-api';
 */

/** One request the SDK made to the fake api.polar.sh. */
export interface FakePolarRequest {
  method: string;
  path: string;
  query: URLSearchParams;
}

/**
 * Answers one request. `signal` is the request's own, which carries the SDK's
 * timeout — see hangUntilAborted.
 */
export type FakePolarResponder = (req: FakePolarRequest, signal: AbortSignal) => Response | Promise<Response>;

class FakePolarApi {
  requests: FakePolarRequest[] = [];
  respond: FakePolarResponder | null = null;

  reset(respond: FakePolarResponder): void {
    this.requests = [];
    this.respond = respond;
  }

  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    const req: FakePolarRequest = { method: request.method, path: url.pathname, query: url.searchParams };
    this.requests.push(req);
    if (!this.respond) throw new Error('fake Polar API has no responder — call fakePolarApi.reset() first');
    return this.respond(req, request.signal);
  }
}

export const fakePolarApi = new FakePolarApi();

export function polarModuleOverFakeApi(polarModule: typeof PolarSdkModule) {
  const RealPolar = polarModule.Polar;
  class PolarOverFakeApi extends RealPolar {
    constructor(options: ConstructorParameters<typeof RealPolar>[0] = {}) {
      super({
        ...options,
        httpClient: new HTTPClient({ fetcher: (input, init) => fakePolarApi.fetch(input, init) }),
      });
    }
  }
  return { ...polarModule, Polar: PolarOverFakeApi };
}

export function polarJson(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Polar's error envelope, e.g. polarApiError(403, 'AlreadyCanceledSubscription'). */
export function polarApiError(status: number, error: string, detail = 'fake detail'): Response {
  return polarJson(status, { error, detail });
}

/** A page of GET /v1/subscriptions/. */
export function polarSubscriptionPage(items: unknown[]): Response {
  return polarJson(200, { items, pagination: { total_count: items.length, max_page: 1 } });
}

/**
 * A Polar that never answers. Settles only when the request's signal aborts,
 * which is the SDK's own per-request timeout firing — so a call made without
 * `timeoutMs` hangs here exactly as it would against a stalled api.polar.sh.
 */
export function hangUntilAborted(signal: AbortSignal): Promise<Response> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}
