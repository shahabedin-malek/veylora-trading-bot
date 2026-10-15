import DecimalJS from "decimal.js";
import ccxt from "ccxt";
import type { TradingVenue, VenueCredentialMaterial } from "@/lib/trading/credential-vault";

const Decimal = DecimalJS.clone({ precision: 80 });
const MAX_BALANCE_ASSETS = 200;

type RawBalance = {
  free?: Record<string, string | number | null | undefined>;
  total?: Record<string, string | number | null | undefined>;
};

type SpotExchange = {
  fetchBalance(): Promise<RawBalance>;
  close(): Promise<void>;
};

export type VerifiedSpotBalance = {
  asset: string;
  available: string;
  total: string;
};

function amount(value: string | number | null | undefined): InstanceType<typeof Decimal> {
  if (value === null || value === undefined) return new Decimal(0);
  const parsed = new Decimal(String(value));
  if (!parsed.isFinite() || parsed.isNegative()) throw new Error("Venue returned an invalid balance.");
  return parsed;
}

export function normalizeSpotBalances(balance: RawBalance): VerifiedSpotBalance[] {
  const free = balance.free ?? {};
  const total = balance.total ?? {};
  const assets = [...new Set([...Object.keys(free), ...Object.keys(total)])].sort();
  if (assets.length > MAX_BALANCE_ASSETS) throw new Error("Venue returned too many balance assets.");

  return assets.flatMap((asset) => {
    const available = amount(free[asset]);
    const held = amount(total[asset]);
    if (available.isZero() && held.isZero()) return [];
    return [{ asset, available: available.toFixed(), total: held.toFixed() }];
  });
}

function createSpotExchange(venue: TradingVenue, credentials: VenueCredentialMaterial): SpotExchange {
  const config = {
    apiKey: credentials.apiKey,
    secret: credentials.apiSecret,
    enableRateLimit: true,
    timeout: 10_000,
  };

  if (venue === "binance") {
    return new ccxt.binance({ ...config, options: { defaultType: "spot" } }) as unknown as SpotExchange;
  }
  if (venue === "kraken") {
    return new ccxt.kraken(config) as unknown as SpotExchange;
  }
  if (venue === "coinbase-advanced") {
    return new ccxt.coinbase(config) as unknown as SpotExchange;
  }
  throw new Error("Unsupported venue.");
}

export async function fetchVerifiedSpotBalances(
  venue: TradingVenue,
  credentials: VenueCredentialMaterial,
): Promise<VerifiedSpotBalance[]> {
  const exchange = createSpotExchange(venue, credentials);
  try {
    return normalizeSpotBalances(await exchange.fetchBalance());
  } finally {
    await exchange.close().catch(() => undefined);
  }
}