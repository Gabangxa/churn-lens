/**
 * Best-effort in-memory fixed-window rate limiter.
 *
 * Process-local: state resets on restart and is NOT shared across instances, so
 * it's a speed bump against abuse (unbounded org creation, opt-out spam), not a
 * hard guarantee. If ChurnLens ever runs more than one instance, move this to
 * Redis or a Postgres-backed counter.
 */
interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until the window resets (0 when allowed). */
  retryAfterSec: number;
}

export function checkRateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();

  // Opportunistic prune so the map can't grow without bound. (Deleting during
  // Map.forEach is safe.)
  if (buckets.size > 10_000) {
    buckets.forEach((v, k) => {
      if (now >= v.resetAt) buckets.delete(k);
    });
  }

  const bucket = buckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, retryAfterSec: 0 };
  }

  if (bucket.count >= limit) {
    return { allowed: false, retryAfterSec: Math.ceil((bucket.resetAt - now) / 1000) };
  }

  bucket.count += 1;
  return { allowed: true, retryAfterSec: 0 };
}

/**
 * Best-effort client IP from proxy headers — the LAST hop of X-Forwarded-For,
 * not the first.
 *
 * X-Forwarded-For is a comma-separated list each proxy APPENDS to; Railway's
 * edge proxy is the last hop to touch the header before it reaches this
 * process, so its append is the only entry here that isn't attacker-supplied.
 * Every earlier entry is whatever the client (or an upstream proxy relaying
 * the client's own header) chose to send — trusting the first hop let a single
 * caller rotate through fake IPs (`X-Forwarded-For: 1.2.3.4`) to get a fresh
 * rate-limit bucket on every request.
 */
export function clientIp(req: Request): string {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) {
    const hops = xff.split(',').map((hop) => hop.trim()).filter(Boolean);
    if (hops.length > 0) return hops[hops.length - 1];
  }
  return req.headers.get('x-real-ip') ?? 'unknown';
}
