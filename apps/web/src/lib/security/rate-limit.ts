/**
 * A bounded, process-local request limiter for the two surfaces that had none: sign-in and the
 * money mutations.
 *
 * Its job is to make a burst cost something. A password-equivalent wallet signature, a nonce
 * mint or a withdrawal submission is expensive or consequential, and without a ceiling an
 * unauthenticated caller can ask for them as fast as the network allows. The public API, the
 * RPC proxy and Tavily already have their own counters; this one covers the session and
 * ledger paths they do not share.
 *
 * What it is not: a distributed limiter. The buckets live in one process, so a deployment with
 * several instances limits each instance separately. That is stated here and in the phase
 * report rather than implied away — it still turns an unbounded burst into a bounded one per
 * instance, and it costs no round trip on the request path.
 */

export type RateLimitDecision = {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Epoch milliseconds at which the current window ends and the count resets. */
  resetAt: number;
  retryAfterSeconds: number;
};

type Bucket = { windowStart: number; count: number };

const buckets = new Map<string, Bucket>();

/**
 * Capacity of the map, not of a bucket. Keys are caller-derived (an IP or a user id), and an
 * unbounded map would let an attacker grow memory by inventing addresses. Oldest entries are
 * evicted first when the cap is reached; the cost of an eviction is one reset bucket.
 */
const MAX_BUCKETS = 10_000;

export const RATE_WINDOW_MS = 60_000;

/**
 * The caller's address, as the deployment's proxy reports it.
 *
 * `x-real-ip` first (Vercel sets it and does not let a client override it), then the first hop
 * of `x-forwarded-for`. A request with neither shares the `unknown` bucket, which is deliberate:
 * an unattributable caller is limited like one address rather than exempted.
 */
export function clientAddress(request: Request): string {
  const real = request.headers.get("x-real-ip")?.trim();
  if (real) return real;
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || "unknown";
}

export function consumeRateLimit(
  key: string,
  limit: number,
  options: { windowMs?: number; now?: number } = {},
): RateLimitDecision {
  const windowMs = options.windowMs ?? RATE_WINDOW_MS;
  const now = options.now ?? Date.now();
  if (!Number.isFinite(limit) || limit < 1) throw new RangeError("A rate limit must be at least one request.");

  const existing = buckets.get(key);
  const bucket = !existing || now - existing.windowStart >= windowMs
    ? { windowStart: now, count: 0 }
    : existing;

  if (bucket.count >= limit) {
    // Keep the existing window so the reset time is stable across refused requests.
    buckets.set(key, bucket);
    return {
      allowed: false,
      limit,
      remaining: 0,
      resetAt: bucket.windowStart + windowMs,
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.windowStart + windowMs - now) / 1000)),
    };
  }

  bucket.count += 1;
  buckets.set(key, bucket);
  if (buckets.size > MAX_BUCKETS) evictStale(now, windowMs);

  return {
    allowed: true,
    limit,
    remaining: limit - bucket.count,
    resetAt: bucket.windowStart + windowMs,
    retryAfterSeconds: Math.max(1, Math.ceil((bucket.windowStart + windowMs - now) / 1000)),
  };
}

function evictStale(now: number, windowMs: number): void {
  for (const [key, bucket] of buckets) {
    if (now - bucket.windowStart >= windowMs) buckets.delete(key);
  }
  // Still over the cap (nothing was stale): drop insertion-order oldest entries.
  while (buckets.size > MAX_BUCKETS) {
    const oldest = buckets.keys().next().value;
    if (oldest === undefined) break;
    buckets.delete(oldest);
  }
}

/** A 429 with the numbers a caller needs, in the same shape as the API's own refusals. */
export function rateLimitResponse(decision: RateLimitDecision, message: string): Response {
  return Response.json(
    {
      error: message,
      code: "RATE_LIMITED",
      limit: decision.limit,
      remaining: 0,
      resetAt: new Date(decision.resetAt).toISOString(),
    },
    {
      status: 429,
      headers: {
        "Cache-Control": "no-store",
        "Retry-After": String(decision.retryAfterSeconds),
        "X-RateLimit-Limit": String(decision.limit),
        "X-RateLimit-Remaining": "0",
        "X-RateLimit-Reset": String(Math.floor(decision.resetAt / 1000)),
      },
    },
  );
}

/** Tests call this between cases; nothing in the application does. */
export function resetRateLimits(): void {
  buckets.clear();
}

/** The published ceilings, named so the report and the tests read the same numbers. */
export const RATE_LIMITS = {
  authNoncePerMinute: 120,
  authVerifyPerMinute: 60,
  withdrawalCreatePerMinute: 10,
  orderCreatePerMinute: 60,
} as const;
