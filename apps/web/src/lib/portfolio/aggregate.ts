/**
 * The portfolio read: every enabled network, at once, bounded.
 *
 * Three properties are the whole point of this module:
 *
 *  1. **Concurrency is bounded and each network has its own deadline.** One
 *     network that hangs costs one network's timeout, not the response: the
 *     signal that ends it is the same one the fetches carry, so the work stops
 *     rather than being abandoned in the background.
 *  2. **Rows are complete when they are complete.** `onNetwork` fires as each
 *     network settles, which is what lets the route stream them.
 *  3. **A missing network stays visible.** A row with no holdings and a status of
 *     `unavailable` or `timeout` is part of the answer, and the summary names it.
 *     There is no arithmetic path that turns a failed read into a smaller total
 *     presented as complete.
 *
 * This module does not price anything and does not know about the database: the
 * metadata store, the allow-list and the fetch implementation are all inputs, so
 * the aggregation can be exercised with a dead network and a stopped cache.
 */
import type { EvmMainnet } from "@/lib/portfolio/evm-mainnets";
import {
  readAlchemyTokenMetadata,
  readEvmRawBalances,
  type EvmRawBalances,
} from "@/lib/portfolio/ethereum";
import {
  buildNetworkPortfolio,
  summarizePortfolio,
  type NetworkPortfolio,
  type PortfolioSummary,
  type RawTokenHolding,
} from "@/lib/portfolio/positions";
import {
  resolveTokenMetadata,
  type TokenMetadataReader,
  type TokenMetadataStore,
} from "@/lib/portfolio/tokens";

/** How many networks are read at once. */
export const NETWORK_CONCURRENCY = 4;
/** The whole per-network budget: balances, metadata and the write-back. */
export const NETWORK_TIMEOUT_MS = 12_000;

export type PortfolioReadResult = {
  walletAddress: string;
  readAt: string;
  networks: NetworkPortfolio[];
  summary: PortfolioSummary;
  warnings: string[];
};

export type PortfolioReadInput = {
  walletAddress: string;
  /** The enabled networks, in display order. */
  networks: readonly EvmMainnet[];
  /** Checksummed allow-listed contracts, per chain. */
  allowListByChain?: ReadonlyMap<number, ReadonlySet<string>>;
  store: TokenMetadataStore;
  metadataReader?: TokenMetadataReader;
  fetcher?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  concurrency?: number;
  /** Bypass the freshness window for this read (not the cache itself). */
  refreshMetadata?: boolean;
  /** Called as each network settles; used by the streaming route. */
  onNetwork?: (row: NetworkPortfolio) => void;
};

type Timed<T> = { timedOut: true } | { timedOut: false; value: T };

/**
 * Run `task` under a deadline, handing it the signal that ends it.
 *
 * The loser of the race is aborted rather than forgotten: `controller.abort()`
 * reaches every fetch the task started through its signal.
 */
export async function withDeadline<T>(
  task: (signal: AbortSignal) => Promise<T>,
  ms: number,
): Promise<Timed<T>> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<Timed<T>>((resolve) => {
    timer = setTimeout(() => {
      controller.abort(new Error("Portfolio read timed out."));
      resolve({ timedOut: true });
    }, ms);
  });
  try {
    return await Promise.race([
      task(controller.signal).then((value): Timed<T> => ({ timedOut: false, value })),
      deadline,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Run `worker` over `items` with at most `limit` in flight, keeping result order. */
export async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const width = Math.max(1, Math.min(limit, items.length));
  await Promise.all(
    Array.from({ length: width }, async () => {
      for (;;) {
        const index = next++;
        if (index >= items.length) return;
        results[index] = await worker(items[index]!, index);
      }
    }),
  );
  return results;
}

function unavailableRow(
  network: EvmMainnet,
  status: "unavailable" | "timeout",
  reason: string,
  readAt: string,
): NetworkPortfolio {
  return buildNetworkPortfolio({
    network,
    status,
    reason,
    readAt,
    native: null,
    tokens: [],
    allowList: new Set(),
  });
}

async function readNetwork(
  network: EvmMainnet,
  input: PortfolioReadInput,
  readAt: string,
  timeoutMs: number,
): Promise<NetworkPortfolio> {
  const allowList = input.allowListByChain?.get(network.chainId) ?? new Set<string>();
  const fetcher = input.fetcher ?? fetch;
  const metadataReader: TokenMetadataReader = input.metadataReader ?? ((request) =>
    readAlchemyTokenMetadata(request.chainId, request.addresses, fetcher, input.env ?? process.env, request.signal));

  const outcome = await withDeadline(async (signal) => {
    const raw: EvmRawBalances = await readEvmRawBalances(
      network.chainId,
      input.walletAddress,
      [...allowList],
      fetcher,
      input.env ?? process.env,
      signal,
    );

    if (raw.status !== "available") {
      return buildNetworkPortfolio({
        network,
        status: "unavailable",
        reason: raw.status === "not-connected"
          ? `${network.name} is not connected — no RPC endpoint is configured for it.`
          : raw.reason,
        readAt,
        native: null,
        tokens: [],
        allowList,
      });
    }

    const resolution = await resolveTokenMetadata({
      chainId: network.chainId,
      addresses: raw.tokens.map(({ contractAddress }) => contractAddress),
      store: input.store,
      reader: metadataReader,
      refresh: input.refreshMetadata,
      signal,
    });

    const metadataByAddress = new Map(resolution.tokens.map((token) => [token.contractAddress, token]));
    const tokens: RawTokenHolding[] = [];
    const warnings = [...raw.warnings, ...resolution.warnings];
    for (const token of raw.tokens) {
      const metadata = metadataByAddress.get(token.contractAddress);
      if (!metadata) {
        warnings.push(`Metadata for ${token.contractAddress} was not resolved; the holding was skipped.`);
        continue;
      }
      tokens.push({ contractAddress: token.contractAddress, rawAmount: token.rawAmount, metadata });
    }

    return buildNetworkPortfolio({
      network,
      status: "available",
      reason: null,
      readAt,
      native: { rawAmount: raw.nativeRaw, symbol: raw.nativeSymbol, decimals: raw.nativeDecimals },
      tokens,
      allowList,
      truncated: raw.truncated,
      metadata: resolution.cache === "hit"
        ? "cache-hit"
        : resolution.cache === "miss" ? "cache-miss" : "cache-unavailable",
      warnings,
    });
  }, timeoutMs);

  if (outcome.timedOut) {
    return unavailableRow(
      network,
      "timeout",
      `${network.name} did not answer within ${Math.round(timeoutMs / 1_000)}s; the other networks are unaffected.`,
      readAt,
    );
  }
  return outcome.value;
}

/**
 * Read every network, in display order, calling `onNetwork` as each settles.
 *
 * The returned rows are ordered by the input list, not by completion: a stream
 * may show Base before Ethereum, while the snapshot a reader holds is stable.
 */
export async function readPortfolio(input: PortfolioReadInput): Promise<PortfolioReadResult> {
  if (input.networks.length === 0) {
    const readAt = new Date().toISOString();
    return {
      walletAddress: input.walletAddress,
      readAt,
      networks: [],
      summary: summarizePortfolio([], readAt),
      warnings: ["No EVM mainnet is enabled for this account."],
    };
  }

  const readAt = new Date().toISOString();
  const timeoutMs = input.timeoutMs ?? NETWORK_TIMEOUT_MS;
  const rows = await mapBounded(
    input.networks,
    input.concurrency ?? NETWORK_CONCURRENCY,
    async (network) => {
      let row: NetworkPortfolio;
      try {
        row = await readNetwork(network, input, readAt, timeoutMs);
      } catch {
        row = unavailableRow(
          network,
          "unavailable",
          `${network.name} could not be read; the other networks are unaffected.`,
          readAt,
        );
      }
      // A listener that throws must not fail the read it is observing.
      try {
        input.onNetwork?.(row);
      } catch {
        // The stream is a presentation of the read, not part of it.
      }
      return row;
    },
  );

  return {
    walletAddress: input.walletAddress,
    readAt,
    networks: rows,
    summary: summarizePortfolio(rows, readAt),
    warnings: rows
      .filter(({ status }) => status !== "available")
      .map(({ networkName, reason }) => `${networkName}: ${reason ?? "no answer"}`),
  };
}
