import { NextResponse } from 'next/server';

// Liveness probe for Railway's healthcheck (railway.json -> healthcheckPath).
// Intentionally does no DB work — boot-time env validation already fails fast in
// src/instrumentation.ts, so a 200 here means the server started with valid config.
// force-dynamic keeps it from being statically optimized into a cached response.
export const dynamic = 'force-dynamic';

export function GET() {
  return NextResponse.json({ ok: true });
}
