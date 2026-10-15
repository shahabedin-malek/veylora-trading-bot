const WINDOW_MS = 60_000;
const REQUEST_LIMIT = 5;
const MAX_BUCKETS = 1_000;
const requestsByUser = new Map<string, { startedAt: number; count: number }>();

export function consumeTavilyRequest(userId: string, now = Date.now()): boolean {
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
  if (current.count >= REQUEST_LIMIT) return false;
  current.count += 1;
  return true;
}