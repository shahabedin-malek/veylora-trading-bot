import { prisma } from "@/lib/db";

/**
 * Per-key rate limiting (phase 32).
 *
 * The allowance is a fixed minute rather than a sliding window: a caller that is told
 * "60 per minute, reset at 10:01:00Z" can act on that, while a sliding approximation makes
 * the reset time a number that keeps moving. The counter lives in the database so two
 * serverless instances count the same request stream instead of each allowing a full
 * allowance.
 *
 * Exceeding the allowance is a 429 with the limit and the reset time in both the body and
 * the headers. It is not a silently dropped request and not a 500.
 */

export const API_RATE_WINDOW_MS = 60_000;
export const API_RATE_LIMIT_HEADER = "X-RateLimit-Limit";
export const API_RATE_REMAINING_HEADER = "X-RateLimit-Remaining";
export const API_RATE_RESET_HEADER = "X-RateLimit-Reset";

export type ApiRateLimitStore = {
  /** Count one request in the window and return the new total. */
  increment(input: { keyId: string; windowStart: Date }): Promise<number>;
};

export type ApiRateLimitResult = {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: string;
  windowStart: string;
  count: number;
};

export function rateWindowStart(now: Date): Date {
  return new Date(Math.floor(now.getTime() / API_RATE_WINDOW_MS) * API_RATE_WINDOW_MS);
}

export async function consumeApiRateLimit(input: {
  store: ApiRateLimitStore;
  keyId: string;
  limit: number;
  now?: Date;
}): Promise<ApiRateLimitResult> {
  const now = input.now ?? new Date();
  const windowStart = rateWindowStart(now);
  const count = await input.store.increment({ keyId: input.keyId, windowStart });
  const resetAt = new Date(windowStart.getTime() + API_RATE_WINDOW_MS).toISOString();
  return {
    allowed: count <= input.limit,
    limit: input.limit,
    remaining: Math.max(0, input.limit - count),
    resetAt,
    windowStart: windowStart.toISOString(),
    count,
  };
}

export function rateLimitHeaders(result: ApiRateLimitResult): Record<string, string> {
  return {
    [API_RATE_LIMIT_HEADER]: String(result.limit),
    [API_RATE_REMAINING_HEADER]: String(result.remaining),
    [API_RATE_RESET_HEADER]: result.resetAt,
  };
}

export function createPrismaApiRateLimitStore(): ApiRateLimitStore {
  return {
    async increment({ keyId, windowStart }) {
      const row = await prisma.apiRateWindow.upsert({
        where: { keyId_windowStart: { keyId, windowStart } },
        create: { keyId, windowStart, count: 1 },
        update: { count: { increment: 1 } },
        select: { count: true },
      });
      return row.count;
    },
  };
}
