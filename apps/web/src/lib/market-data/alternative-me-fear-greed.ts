export const ALTERNATIVE_ME_FEAR_GREED_URL = "https://api.alternative.me/fng/?limit=1&format=json";

const CACHE_TTL_MS = 5 * 60_000;
const MAX_RESPONSE_BYTES = 16_384;
const CLASSIFICATIONS = new Set(["Extreme Fear", "Fear", "Neutral", "Greed", "Extreme Greed"]);

export type BitcoinFearGreedReading = {
  value: number;
  classification: string;
  observedAt: string;
  nextUpdateSeconds: number | null;
};

let cachedReading: { fetchedAt: number; reading: BitcoinFearGreedReading } | null = null;
let pendingRead: Promise<BitcoinFearGreedReading> | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseBitcoinFearGreedResponse(value: unknown): BitcoinFearGreedReading {
  if (!isRecord(value) || !Array.isArray(value.data)) throw new Error("Alternative.me response was invalid.");
  const latest = value.data[0];
  if (!isRecord(latest)) throw new Error("Alternative.me response had no current reading.");
  const numericValue = typeof latest.value === "string" ? Number(latest.value) : latest.value;
  const timestamp = typeof latest.timestamp === "string" ? Number(latest.timestamp) : latest.timestamp;
  if (
    typeof numericValue !== "number" || !Number.isInteger(numericValue) || numericValue < 0 || numericValue > 100 ||
    typeof latest.value_classification !== "string" || !CLASSIFICATIONS.has(latest.value_classification) ||
    typeof timestamp !== "number" || !Number.isSafeInteger(timestamp) || timestamp <= 0
  ) {
    throw new Error("Alternative.me reading failed validation.");
  }
  const nextUpdate = typeof latest.time_until_update === "string" ? Number(latest.time_until_update) : latest.time_until_update;
  return {
    value: numericValue,
    classification: latest.value_classification,
    observedAt: new Date(timestamp * 1_000).toISOString(),
    nextUpdateSeconds: typeof nextUpdate === "number" && Number.isSafeInteger(nextUpdate) && nextUpdate >= 0 ? nextUpdate : null,
  };
}

async function fetchReading(): Promise<BitcoinFearGreedReading> {
  const response = await fetch(ALTERNATIVE_ME_FEAR_GREED_URL, {
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`Alternative.me request failed with status ${response.status}.`);
  const rawBody = await response.text();
  if (Buffer.byteLength(rawBody, "utf8") > MAX_RESPONSE_BYTES) throw new Error("Alternative.me response exceeded the allowed size.");
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody) as unknown;
  } catch {
    throw new Error("Alternative.me returned invalid JSON.");
  }
  return parseBitcoinFearGreedResponse(payload);
}

export async function getBitcoinFearGreedIndex(now = Date.now()): Promise<BitcoinFearGreedReading> {
  if (cachedReading && now - cachedReading.fetchedAt < CACHE_TTL_MS) return cachedReading.reading;
  if (pendingRead) return pendingRead;
  pendingRead = fetchReading()
    .then((reading) => {
      cachedReading = { fetchedAt: Date.now(), reading };
      return reading;
    })
    .finally(() => {
      pendingRead = null;
    });
  return pendingRead;
}

export function resetFearGreedCacheForTests() {
  cachedReading = null;
  pendingRead = null;
}