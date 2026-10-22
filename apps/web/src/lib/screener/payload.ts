import type { MarketAlertCondition } from "@/lib/alerts/conditions";
import { MARKET_ALERT_CONDITIONS } from "@/lib/alerts/conditions";
import { getCurrentUser } from "@/lib/auth/session-store";
import { marketDataHealth, type MarketDataSourceHealth } from "@/lib/market-data/health";
import { FINANCIAL_RSS_PROVIDER_IDS } from "@/lib/market-data/rss-feeds";
import { USD_WATCHLIST } from "@/lib/market-data/watchlist";
import { getProviderCallHealth, PROVIDER_IDS, type ProviderCallHealth } from "@/lib/observability/provider-call";
import { listScreeners, type StoredScreener } from "@/lib/screener/service";

/**
 * Everything the screener surface needs for its first paint, loaded once.
 *
 * The page renders this on the server and the GET route serves the same shape,
 * so the client has one initial payload instead of a loading state and an effect
 * that should have been a server read. A database that cannot be read leaves the
 * saved screens empty and says so; the watchlist is code, not data, so the
 * condition form still works.
 */
export type ScreenerPayload = {
  authenticated: boolean;
  storageUnavailable: boolean;
  screens: StoredScreener[];
  health: ProviderCallHealth[];
  ingestHealth: MarketDataSourceHealth[];
  watchlist: { productId: string; name: string }[];
  conditions: MarketAlertCondition[];
  now: string;
};

const MARKET_PROVIDER_IDS = new Set<string>([
  PROVIDER_IDS.coinbase,
  "coinbase-exchange-status",
  ...FINANCIAL_RSS_PROVIDER_IDS,
]);

function marketHealth(health: readonly ProviderCallHealth[]): ProviderCallHealth[] {
  return health.filter((entry) => MARKET_PROVIDER_IDS.has(entry.providerId));
}

export async function loadScreenerPayload(): Promise<ScreenerPayload> {
  let authenticated = false;
  let screens: StoredScreener[] = [];
  let storageUnavailable = false;

  try {
    const user = await getCurrentUser();
    authenticated = user !== null;
    if (user) screens = await listScreeners(user.id);
  } catch {
    storageUnavailable = true;
  }

  let health: ProviderCallHealth[] = [];
  try {
    health = marketHealth(await getProviderCallHealth());
  } catch {
    // Health is an observation. A database that cannot be read leaves the table
    // empty rather than failing the screen that reads market data.
  }

  return {
    authenticated,
    storageUnavailable,
    screens,
    health,
    ingestHealth: marketDataHealth().snapshot(),
    watchlist: USD_WATCHLIST.map(({ productId, name }) => ({ productId, name })),
    conditions: [...MARKET_ALERT_CONDITIONS],
    now: new Date().toISOString(),
  };
}
