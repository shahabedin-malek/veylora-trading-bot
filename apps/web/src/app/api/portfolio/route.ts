import { prisma } from "@/lib/db";
import { getAccessRefusal } from "@/lib/auth/access-gate";
import { requireUser } from "@/lib/auth/session-store";
import { readPortfolio, type PortfolioReadInput, type PortfolioReadResult } from "@/lib/portfolio/aggregate";
import { getEnabledEvmMainnetChainIds, getEvmMainnet, type EvmMainnet } from "@/lib/portfolio/evm-mainnets";
import { isChecksummedAddress } from "@/lib/portfolio/ethereum-token-allowlist";
import { createPrismaTokenMetadataStore } from "@/lib/portfolio/token-metadata-store";
import { auditCreate } from "@/lib/audit/record";

/**
 * The aggregated portfolio, as a snapshot (`application/json`) or as it happens
 * (`text/event-stream`).
 *
 * The stream is the default the panel uses: `start` names every network that will
 * be read, then one `network` event per settled row, then the `summary`. That is
 * requirement 6 — networks that answered appear first — without the page waiting
 * for the slowest chain.
 *
 * Reading a portfolio is not a money-moving action, so there is no confirmation
 * and no step-up here: the only gate is being signed in.
 */

const NO_STORE = { "Cache-Control": "no-store, private" } as const;

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: NO_STORE });
}

function readFailure(error: unknown) {
  const refusal = getAccessRefusal(error);
  if (refusal) return json({ error: refusal.error }, refusal.status);
  return json({ error: "Portfolio reads are unavailable." }, 503);
}

type PortfolioQuery = {
  networks: EvmMainnet[];
  allowListByChain: Map<number, Set<string>>;
};

async function loadPortfolioQuery(userId: string): Promise<PortfolioQuery | { error: string }> {
  const [networkEntries, tokenEntries] = await Promise.all([
    prisma.evmPortfolioNetwork.findMany({
      where: { userId },
      orderBy: { enabledAt: "asc" },
      select: { chainId: true },
    }),
    prisma.evmTokenAllowlistEntry.findMany({
      where: { userId },
      orderBy: { createdAt: "asc" },
      select: { chainId: true, contractAddress: true },
    }),
  ]);

  const chainIds = getEnabledEvmMainnetChainIds(networkEntries.map(({ chainId }) => chainId));
  if (!chainIds) return { error: "Stored network allow-list failed validation." };

  const allowListByChain = new Map<number, Set<string>>();
  for (const entry of tokenEntries) {
    if (!chainIds.includes(entry.chainId) || !isChecksummedAddress(entry.contractAddress)) {
      return { error: "Stored token allow-list failed checksum validation." };
    }
    const set = allowListByChain.get(entry.chainId) ?? new Set<string>();
    set.add(entry.contractAddress);
    allowListByChain.set(entry.chainId, set);
  }

  return {
    networks: chainIds.map((chainId) => getEvmMainnet(chainId)!),
    allowListByChain,
  };
}

function portfolioStatus(result: PortfolioReadResult) {
  if (result.networks.length === 0) return "unavailable" as const;
  if (result.summary.answered === 0) return "unavailable" as const;
  return result.summary.complete ? "available" as const : "partial" as const;
}

function allowListEntries(query: PortfolioQuery) {
  return [...query.allowListByChain].flatMap(([chainId, addresses]) =>
    [...addresses].map((contractAddress) => ({ chainId, contractAddress })));
}

function snapshot(result: PortfolioReadResult, query: PortfolioQuery) {
  return {
    status: portfolioStatus(result),
    walletAddress: result.walletAddress,
    readAt: result.readAt,
    networks: result.networks,
    summary: result.summary,
    allowList: allowListEntries(query),
    warnings: result.warnings,
  };
}

async function recordView(userId: string, result: PortfolioReadResult): Promise<void> {
  try {
    await auditCreate(prisma, {
      data: {
        actorUserId: userId,
        action: "PORTFOLIO_AGGREGATE_VIEWED",
        objectType: "Portfolio",
        objectId: userId,
        outcome: "SUCCESS",
        redactedJson: JSON.stringify({
          networks: result.networks.map(({ chainId, status, holdings }) => ({
            chainId,
            status,
            holdings: holdings.length,
          })),
          answered: result.summary.answered,
        }),
      },
    });
  } catch {
    // The trail is an observation of the read. Losing it must not fail the read.
  }
}

function eventStream(
  user: { id: string },
  query: PortfolioQuery,
  walletAddress: string,
  readAt: string,
  input: Omit<PortfolioReadInput, "networks" | "allowListByChain" | "walletAddress" | "onNetwork">,
  request: Request,
) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      };
      const finish = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // Already closed by the client.
        }
      };
      request.signal.addEventListener("abort", () => {
        closed = true;
        finish();
      }, { once: true });

      send("start", {
        walletAddress,
        readAt,
        networks: query.networks.map(({ alchemyNetwork, name, chainId }) => ({
          network: alchemyNetwork,
          networkName: name,
          chainId,
        })),
        allowList: allowListEntries(query),
      });

      void readPortfolio({
        ...input,
        walletAddress,
        networks: query.networks,
        allowListByChain: query.allowListByChain,
        onNetwork: (row) => send("network", row),
      }).then(async (result) => {
        send("summary", {
          status: portfolioStatus(result),
          readAt: result.readAt,
          summary: result.summary,
          warnings: result.warnings,
        });
        await recordView(user.id, result);
        send("done", {});
        finish();
      }).catch((error: unknown) => {
        send("error", { message: error instanceof Error ? error.message : "Portfolio read failed." });
        finish();
      });
    },
  });

  return new Response(stream, {
    headers: {
      ...NO_STORE,
      "Content-Type": "text/event-stream; charset=utf-8",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

export async function GET(request: Request) {
  let user;
  try {
    user = await requireUser();
  } catch (error) {
    return readFailure(error);
  }

  if (!user.address || user.chainNamespace !== "eip155") {
    return json({
      error: "Connect a verified EVM wallet to read this portfolio.",
      status: "unavailable",
      networks: [],
    }, 409);
  }

  let query: PortfolioQuery;
  try {
    const loaded = await loadPortfolioQuery(user.id);
    if ("error" in loaded) return json({ error: loaded.error }, 503);
    query = loaded;
  } catch {
    return json({ error: "Portfolio configuration could not be read." }, 503);
  }

  const url = new URL(request.url);
  const input = {
    store: createPrismaTokenMetadataStore(),
    refreshMetadata: url.searchParams.get("refresh") === "1",
  };
  const walletAddress = user.address;
  const readAt = new Date().toISOString();

  if (request.headers.get("accept")?.toLowerCase().includes("text/event-stream")) {
    return eventStream(user, query, walletAddress, readAt, input, request);
  }

  try {
    const result = await readPortfolio({
      ...input,
      walletAddress,
      networks: query.networks,
      allowListByChain: query.allowListByChain,
    });
    await recordView(user.id, result);
    return json(snapshot(result, query));
  } catch {
    return json({ error: "Portfolio read failed." }, 503);
  }
}
