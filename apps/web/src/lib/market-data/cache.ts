import type { MarketDataResult } from "@/lib/market-data/provider";

type CacheEntry<T> = {
  data: readonly T[];
  expiresAt: number;
};

export class MarketCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();
  private readonly inFlight = new Map<string, Promise<MarketDataResult<T>>>();

  constructor(private readonly maxEntries = 256) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError("Market cache capacity must be a positive integer.");
    }
  }

  async get(
    key: string,
    load: () => Promise<MarketDataResult<T>>,
    ttlMs: number,
    now: () => number = Date.now,
  ): Promise<MarketDataResult<T>> {
    if (!key.trim()) throw new TypeError("Market cache key cannot be empty.");
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new RangeError("Market cache TTL must be a positive finite number.");
    }

    const entry = this.entries.get(key);
    if (entry && entry.expiresAt > now()) {
      this.entries.delete(key);
      this.entries.set(key, entry);
      return { status: "available", data: entry.data };
    }
    this.entries.delete(key);

    const existingLoad = this.inFlight.get(key);
    if (existingLoad) return existingLoad;

    const pendingLoad = (async (): Promise<MarketDataResult<T>> => {
      let result: MarketDataResult<T>;
      try {
        result = await load();
      } catch {
        return { status: "unavailable", reason: "provider-error", retryable: true };
      }

      if (result.status === "available") {
        this.entries.set(key, { data: result.data, expiresAt: now() + ttlMs });
        while (this.entries.size > this.maxEntries) {
          const oldestKey = this.entries.keys().next().value;
          if (oldestKey === undefined) break;
          this.entries.delete(oldestKey);
        }
      }
      return result;
    })();

    this.inFlight.set(key, pendingLoad);
    try {
      return await pendingLoad;
    } finally {
      if (this.inFlight.get(key) === pendingLoad) this.inFlight.delete(key);
    }
  }

  clear(key?: string): void {
    if (key === undefined) {
      this.entries.clear();
      return;
    }
    this.entries.delete(key);
  }
}