import { NextResponse } from 'next/server';
import { isDynamicServerError } from 'next/dist/client/components/hooks-server-context';
import { isNextRouterError } from 'next/dist/client/components/is-next-router-error';
import { isStaticGenBailoutError } from 'next/dist/client/components/static-generation-bailout';
import {
  ALREADY_REPORTED_HEADER,
  isBadInputDbError,
  reportError,
  warnBadInput,
  type ErrorMeta,
} from '@/lib/report-error';

/**
 * Wrap an App Router route handler so an exception that escapes it is
 * reported, not just logged:
 *
 *   export const POST = withErrorReporting('webhook.stripe', handleStripeWebhook);
 *
 * Why it exists: Next 14.2.35 catches a throw from a route handler, logs it
 * and answers 500 — reportError never hears of it, so nobody is alerted. A
 * Stripe secret that will not decrypt, a session lookup on a dead database,
 * a bookkeeping UPDATE after the real work: all were silent. Next 15's
 * `onRequestError` instrumentation hook is the framework answer; 14.2 has
 * none, so every route export goes through this instead.
 *
 * What a throw becomes:
 *   - Next's own control flow (redirect(), notFound(), the DynamicServerError
 *     a GET throws at build time when it reads cookies or headers, the
 *     bailout `dynamic = 'error'` throws) is rethrown untouched: Next catches
 *     those itself and acts on them. Caught here, redirect() would become a
 *     500, and every `next build` would report (and, with ALERT_EMAIL in the
 *     build's env, email) a "Dynamic server usage" error per cookie-reading
 *     GET route — seen with this check removed.
 *   - A Postgres error caused by a malformed request-supplied value
 *     (isBadInputDbError) is the caller's bad input: 400, one warn line, no
 *     alert — otherwise anyone with a URL could page the operator at will.
 *   - Anything else is reported with step 'unhandled', the HTTP method and
 *     the route params (ids, and cheap: the body is not re-read), and answered
 *     with a generic 500 marked ALREADY_REPORTED_HEADER, so the cron scheduler
 *     does not report it a second time. Webhook senders (Stripe, Polar) still
 *     retry a 5xx.
 *
 * A handler that catches its own failure, reports it and returns a response
 * is left alone: only a throw reaches this, so nothing is reported twice.
 *
 * The signature mirrors the handler's own, `(req, ctx)` or `(req)`, so Next's
 * generated route type checks (`next build`) see exactly what they would see
 * on an unwrapped `export async function POST(...)`.
 */
export function withErrorReporting<Req extends Request, Rest extends unknown[], Res extends Response>(
  context: string,
  handler: (req: Req, ...rest: Rest) => Promise<Res>,
): (req: Req, ...rest: Rest) => Promise<Res | NextResponse> {
  return async (req: Req, ...rest: Rest) => {
    try {
      return await handler(req, ...rest);
    } catch (err) {
      if (isNextControlFlow(err)) throw err;

      const meta: ErrorMeta = { method: req.method, ...routeParams(rest[0]) };
      if (isBadInputDbError(err)) {
        warnBadInput(context, err, meta);
        return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
      }
      reportError(context, err, { step: 'unhandled', ...meta });
      return NextResponse.json(
        { error: 'Internal error' },
        { status: 500, headers: { [ALREADY_REPORTED_HEADER]: '1' } },
      );
    }
  };
}

function isNextControlFlow(err: unknown): boolean {
  return isNextRouterError(err) || isDynamicServerError(err) || isStaticGenBailoutError(err);
}

/**
 * The `{ params }` Next passes as a handler's second argument, flattened into
 * report meta: a catch-all segment's array is joined with '/'. Params are
 * request input, so they go through reportError's meta scrubbing (redacted,
 * bounded) like any other value.
 */
function routeParams(ctx: unknown): Record<string, string> {
  if (typeof ctx !== 'object' || ctx === null) return {};
  const params = (ctx as { params?: unknown }).params;
  if (typeof params !== 'object' || params === null) return {};

  const flat: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string') flat[key] = value;
    else if (Array.isArray(value)) flat[key] = value.map(String).join('/');
  }
  return flat;
}
