/**
 * Absolute URLs for user-facing redirects.
 *
 * Behind Railway's proxy `req.url` resolves to the *internal* address
 * (https://localhost:8080), so any redirect built from it dead-ends on a host
 * the user's browser cannot reach. Confirmed in production: the magic-link
 * verify, survey submit, and unsubscribe routes all sent users to
 * https://localhost:8080/... The side effects had already run, so no data was
 * lost — but every one of those flows ended on a connection error.
 *
 * Anything that redirects a browser must resolve against NEXT_PUBLIC_APP_URL.
 * We fall back to `req.url` only when that var isn't a usable https origin, so
 * local dev (http://localhost:5000) still lands somewhere sane.
 */

/** The configured public origin, or null when it isn't a usable https URL. */
export function publicAppUrl(): string | null {
  const url = process.env.NEXT_PUBLIC_APP_URL;
  return url && url.startsWith('https://') ? url : null;
}

/**
 * Resolves `path` against the public app URL, falling back to the request's own
 * URL in local dev. Use this for every NextResponse.redirect target.
 */
export function redirectUrl(path: string, req: Request): URL {
  return new URL(path, publicAppUrl() ?? req.url);
}
