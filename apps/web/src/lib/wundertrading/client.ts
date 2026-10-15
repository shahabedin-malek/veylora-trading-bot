import { createHmac } from "node:crypto";

export const WUNDERTRADING_BASE_URL = "https://wundertrading.com";
export const WUNDERTRADING_RECV_WINDOW_MS = 30_000;

export type WunderTradingCredentials = {
  apiKey: string;
  apiSecret: string;
};

const MAX_RESPONSE_BYTES = 1_048_576;
const SENSITIVE_FIELD = /(?:api[_-]?key|access[_-]?key|secret|token|password|signature|credential|private[_-]?key|authorization|bearer|withdraw|passphrase|^key$)/i;

type RequestMethod = "GET" | "PUT" | "DELETE";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function buildWunderTradingSignaturePayload(input: {
  method: RequestMethod;
  path: string;
  timestamp: string;
  recvWindow: number;
  body: string;
}): string {
  return `${input.method}\n${input.path}\n${input.timestamp}\n${input.recvWindow}\n${input.body}`;
}

export function signWunderTradingPayload(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload, "utf8").digest("base64");
}

export function sanitizeWunderTradingResponse(value: unknown, depth = 0): unknown {
  if (depth > 5) return null;
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return value.slice(0, 2_048);
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => sanitizeWunderTradingResponse(item, depth + 1));
  }
  if (!isRecord(value)) return null;

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !SENSITIVE_FIELD.test(key))
      .slice(0, 100)
      .map(([key, item]) => [key.slice(0, 128), sanitizeWunderTradingResponse(item, depth + 1)]),
  );
}

async function readBoundedResponse(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let bytesRead = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error("WunderTrading response exceeded the allowed size.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

async function requestWunderTrading(
  credentials: WunderTradingCredentials,
  method: RequestMethod,
  path: string,
): Promise<unknown> {
  if (!credentials.apiKey.trim() || !credentials.apiSecret.trim()) {
    throw new Error("WunderTrading credentials are incomplete.");
  }
  const timestamp = Date.now().toString();
  const body = "";
  const payload = buildWunderTradingSignaturePayload({
    method,
    path,
    timestamp,
    recvWindow: WUNDERTRADING_RECV_WINDOW_MS,
    body,
  });
  const response = await fetch(new URL(path, WUNDERTRADING_BASE_URL), {
    method,
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
    headers: {
      Accept: "application/json",
      "X-API-Key": credentials.apiKey,
      "X-Signature": signWunderTradingPayload(credentials.apiSecret, payload),
      "X-Timestamp": timestamp,
      "X-Recv-Window": String(WUNDERTRADING_RECV_WINDOW_MS),
    },
  });
  const rawBody = await readBoundedResponse(response);
  if (!response.ok) throw new Error(`WunderTrading request failed with status ${response.status}.`);

  try {
    return JSON.parse(rawBody) as unknown;
  } catch {
    throw new Error("WunderTrading returned invalid JSON.");
  }
}

function responseItems(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (isRecord(value) && Array.isArray(value.items)) return value.items;
  if (isRecord(value) && isRecord(value.result) && Array.isArray(value.result.items)) return value.result.items;
  throw new Error("WunderTrading response did not contain an item list.");
}

export async function listWunderTradingApiProfiles(
  credentials: WunderTradingCredentials,
): Promise<unknown[]> {
  const payload = await requestWunderTrading(credentials, "GET", "/open_api/api_profiles?page=1&limit=100");
  const items = responseItems(payload);
  return sanitizeWunderTradingResponse(items) as unknown[];
}

export async function listWunderTradingLiveStrategies(
  credentials: WunderTradingCredentials,
): Promise<unknown> {
  const payload = await requestWunderTrading(credentials, "GET", "/open_api/strategies/live?page=1&limit=100");
  return sanitizeWunderTradingResponse(payload);
}

export async function listWunderTradingStrategyHistory(
  credentials: WunderTradingCredentials,
): Promise<unknown> {
  const payload = await requestWunderTrading(credentials, "GET", "/open_api/strategies/history?page=1&limit=100");
  return sanitizeWunderTradingResponse(payload);
}