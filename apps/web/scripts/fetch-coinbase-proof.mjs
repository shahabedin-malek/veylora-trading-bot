import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseLosslessJson } from "lossless-json";

const restBase = "https://api.exchange.coinbase.com";
const productId = "BTC-USD";
const fetchedAt = new Date();
const rangeStart = new Date(fetchedAt.getTime() - 3 * 86_400_000);
const bookUrl = new URL(`/products/${productId}/book`, restBase);
bookUrl.searchParams.set("level", "1");
const candlesUrl = new URL(`/products/${productId}/candles`, restBase);
candlesUrl.searchParams.set("granularity", "86400");
candlesUrl.searchParams.set("start", rangeStart.toISOString());
candlesUrl.searchParams.set("end", fetchedAt.toISOString());

async function fetchPublicJson(url) {
  const response = await fetch(url, {
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Public data request failed with HTTP ${response.status}.`);
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > 1_000_000) throw new Error("Public data response exceeded the proof size limit.");
  return {
    body: parseLosslessJson(text),
    rawResponse: text,
    responseHash: createHash("sha256").update(text).digest("hex"),
    httpStatus: response.status,
    providerDate: response.headers.get("date"),
  };
}

const [book, candles] = await Promise.all([fetchPublicJson(bookUrl), fetchPublicJson(candlesUrl)]);
if (
  !Array.isArray(book.body?.bids) ||
  !Array.isArray(book.body?.asks) ||
  book.body.bids.length === 0 ||
  book.body.asks.length === 0 ||
  typeof book.body.time !== "string" ||
  !Array.isArray(candles.body) ||
  candles.body.length === 0 ||
  candles.body.some((candle) => !Array.isArray(candle) || candle.length !== 6)
) {
  throw new Error("Public market-data response did not match the expected shape.");
}

const artifact = {
  schemaVersion: 1,
  provider: "Coinbase Exchange",
  environment: "production",
  authentication: "none",
  productId,
  fetchedAt: fetchedAt.toISOString(),
  requests: [
    {
      kind: "level1-order-book",
      url: bookUrl.toString(),
      httpStatus: book.httpStatus,
      providerDate: book.providerDate,
      responseHash: book.responseHash,
      rawResponse: book.rawResponse,
    },
    {
      kind: "daily-candles",
      url: candlesUrl.toString(),
      httpStatus: candles.httpStatus,
      providerDate: candles.providerDate,
      responseHash: candles.responseHash,
      rawResponse: candles.rawResponse,
    },
  ],
};

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const proofDirectory = path.join(projectRoot, "proof");
const artifactPath = path.join(proofDirectory, "market-data-live.json");
await mkdir(proofDirectory, { recursive: true });
await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 });
console.log(`Wrote public Coinbase market-data proof: ${path.relative(projectRoot, artifactPath)}`);