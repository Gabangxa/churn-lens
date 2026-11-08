import { NextResponse } from 'next/server';
import { withErrorReporting } from '@/lib/with-error-reporting';

// Liveness probe for Railway's healthcheck (railway.json -> healthcheckPath).
// Intentionally does no DB work — boot-time env validation already fails fast in
// src/instrumentation.ts, so a 200 here means the server started with valid config.
// force-dynamic keeps it from being statically optimized into a cached response.
export const dynamic = 'force-dynamic';

// Nothing here can throw today; wrapped anyway so every route export is, and
// a future check added to it is reported rather than silently 500ing.
async function liveness(_req: Request) {
  return NextResponse.json({ ok: true });
}

export const GET = withErrorReporting('health', liveness);
