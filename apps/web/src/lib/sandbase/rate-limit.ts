const WINDOW_MS = 60_000;
/** SandBase calls are heavier than a web search, so one account gets fewer per minute. */
export const SANDBASE_REQUEST_LIMIT = 3;
const MAX_BUCKETS = 1_000;
const requestsByUser = new Map<string, { startedAt: number; count: number }>();

/**
 * One account's SandBase allowance for this minute.
 *
 * The same shape as the research desk's Tavily budget, for the same reason: the provider's
 * limit belongs to the deployment, so one signed-in account must not be able to exhaust it
 * from a chat box. It is a separate bucket from Tavily's rather than a shared one, because
 * spending the search allowance must not silently take the social allowance with it.
 *
 * In-process, like the Tavily bucket: it bounds one server instance's traffic, and the
 * provider's own 429 is the backstop. A refusal is returned, never thrown.
 */
export function consumeSandbaseRequest(userId: string, now = Date.now()): boolean {
  const current = requestsByUser.get(userId);
  if (!current || now - current.startedAt >= WINDOW_MS) {
    if (requestsByUser.size >= MAX_BUCKETS) {
      for (const [key, bucket] of requestsByUser) {
        if (now - bucket.startedAt >= WINDOW_MS) requestsByUser.delete(key);
      }
      if (requestsByUser.size >= MAX_BUCKETS) return false;
    }
    requestsByUser.set(userId, { startedAt: now, count: 1 });
    return true;
  }
  if (current.count >= SANDBASE_REQUEST_LIMIT) return false;
  current.count += 1;
  return true;
}
