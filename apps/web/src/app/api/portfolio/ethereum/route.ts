import { prisma } from "@/lib/db";
import { isChecksummedAddress } from "@/lib/portfolio/ethereum-token-allowlist";
import { isAlchemyEvmMainnetConfigured, readEvmMainnetPortfolio } from "@/lib/portfolio/ethereum";
import { networkSkipDecision, recordNetworkFailure, recordNetworkSuccess } from "@/lib/rpc/health";
import { canonicalNetworkSlug } from "@/lib/rpc/networks";
import { getEnabledEvmMainnetChainIds, getEvmMainnet } from "@/lib/portfolio/evm-mainnets";
import { getAccessRefusal } from "@/lib/auth/access-gate";
import { requireUser } from "@/lib/auth/session-store";
import { recordBalanceRead } from "@/lib/onboarding/signals";
import { auditCreate } from "@/lib/audit/record";

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

/** Names the value that would connect the reads, instead of "API key required". */
const ALCHEMY_NOT_CONFIGURED = "not connected — ALCHEMY_API_KEY (or a per-network ALCHEMY_<NETWORK>_RPC_URL) is not configured";

function notConnected(authenticated: boolean, message = ALCHEMY_NOT_CONFIGURED) {
  return json({ status: "not-connected", message, authenticated, allowlistAvailable: false, networks: [] }, 503);
}

export async function GET() {
  let user;
  try {
    user = await requireUser();
  } catch (error) {
    const refusal = getAccessRefusal(error);
    if (refusal) return json({ error: refusal.error }, refusal.status);
    if (!isAlchemyEvmMainnetConfigured()) return notConnected(false);
    return json({ error: "Wallet portfolio is unavailable." }, 503);
  }

  try {
    const [networkEntries, tokenEntries] = await Promise.all([
      prisma.evmPortfolioNetwork.findMany({
        where: { userId: user.id },
        orderBy: { enabledAt: "asc" },
        select: { chainId: true },
      }),
      prisma.evmTokenAllowlistEntry.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: "asc" },
        select: { chainId: true, contractAddress: true },
      }),
    ]);
    const chainIds = getEnabledEvmMainnetChainIds(networkEntries.map(({ chainId }) => chainId));
    if (!chainIds) {
      return json({ error: "Stored network allow-list failed validation." }, 503);
    }
    if (tokenEntries.some(({ chainId, contractAddress }) => !chainIds.includes(chainId) || !isChecksummedAddress(contractAddress))) {
      return json({ error: "Stored token allow-list failed checksum validation." }, 503);
    }
    const networks = chainIds.map((chainId) => ({
      ...getEvmMainnet(chainId)!,
      contracts: tokenEntries.filter((entry) => entry.chainId === chainId).map(({ contractAddress }) => contractAddress),
    }));

    await auditCreate(prisma, {
      data: {
        actorUserId: user.id,
        action: "EVM_PORTFOLIO_VIEWED",
        objectType: "EvmPortfolio",
        objectId: user.id,
        outcome: "SUCCESS",
        redactedJson: JSON.stringify({ chainIds, tokenCount: tokenEntries.length }),
      },
    });

    if (!isAlchemyEvmMainnetConfigured()) {
      return json({
        status: "not-connected",
        message: ALCHEMY_NOT_CONFIGURED,
        authenticated: true,
        allowlistAvailable: true,
        walletAddress: user.address,
        networks: networks.map((network) => ({ ...network, status: "not-connected" as const, nativeBalance: null, tokens: [] })),
      }, 503);
    }
    if (user.chainNamespace !== "eip155" || user.chainReference !== "1" || !user.address) {
      return json({
        status: "unavailable",
        authenticated: true,
        allowlistAvailable: true,
        message: "Connect a verified Ethereum mainnet wallet to read balances.",
        networks: networks.map((network) => ({ ...network, status: "unavailable" as const, nativeBalance: null, tokens: [] })),
      }, 409);
    }

    const balanceResults = await Promise.all(networks.map(async (network) => {
      // Health is keyed by the canonical slug: a portfolio entry names Ethereum
      // `eth-mainnet`, while the proxy and the registry name it `ethereum-mainnet`.
      const healthSlug = canonicalNetworkSlug(network.alchemyNetwork) ?? network.alchemyNetwork;
      // One dead network is reported, not waited on: the other networks still answer.
      const skip = networkSkipDecision(healthSlug);
      if (skip.skip) {
        return {
          ...network,
          status: "unavailable" as const,
          nativeBalance: null,
          tokens: network.contracts.map((contractAddress) => ({
            contractAddress,
            status: "unavailable" as const,
            balance: null,
          })),
          message: skip.reason,
        };
      }

      const startedAt = Date.now();
      try {
        const balances = await readEvmMainnetPortfolio(network.chainId, user.address!, network.contracts);
        if (balances.status === "available") recordNetworkSuccess(healthSlug, Date.now() - startedAt);
        else if (balances.status === "unavailable") recordNetworkFailure(healthSlug, "portfolio read failed");
        return {
          ...network,
          status: balances.status,
          nativeBalance: balances.status === "available" ? balances.nativeBalance : null,
          tokens: balances.status === "available" ? balances.tokens : network.contracts.map((contractAddress) => ({
            contractAddress,
            status: "unavailable" as const,
            balance: null,
          })),
          ...(balances.status === "unavailable"
            ? { message: `${network.name} did not answer; the other networks are still read.` }
            : {}),
        };
      } catch {
        recordNetworkFailure(healthSlug, "portfolio read threw");
        return {
          ...network,
          status: "unavailable" as const,
          nativeBalance: null,
          tokens: network.contracts.map((contractAddress) => ({
            contractAddress,
            status: "unavailable" as const,
            balance: null,
          })),
          message: `${network.name} did not answer; the other networks are still read.`,
        };
      }
    }));
    const anyAvailable = balanceResults.some(({ status }) => status === "available");

    // A balance was actually read, so the account's onboarding checklist step is
    // satisfied — recorded here rather than in the checklist, because this is the
    // only place that knows a balance was in front of somebody.
    if (anyAvailable) await recordBalanceRead(user.id);

    return json({
      status: anyAvailable ? "available" : "unavailable",
      authenticated: true,
      allowlistAvailable: true,
      walletAddress: user.address,
      networks: balanceResults,
      ...(anyAvailable ? {} : { message: "Ethereum mainnet balances are unavailable." }),
    });
  } catch {
    if (!isAlchemyEvmMainnetConfigured()) {
      return notConnected(true);
    }
    return json({
      status: isAlchemyEvmMainnetConfigured() ? "unavailable" : "not-connected",
      message: isAlchemyEvmMainnetConfigured() ? "Wallet portfolio is unavailable." : ALCHEMY_NOT_CONFIGURED,
      authenticated: true,
      allowlistAvailable: false,
      networks: [],
    }, 503);
  }
}