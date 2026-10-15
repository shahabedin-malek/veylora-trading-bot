import { prisma } from "@/lib/db";
import { isChecksummedAddress } from "@/lib/portfolio/ethereum-token-allowlist";
import { isAlchemyEvmMainnetConfigured, readEvmMainnetPortfolio } from "@/lib/portfolio/ethereum";
import { getEnabledEvmMainnetChainIds, getEvmMainnet } from "@/lib/portfolio/evm-mainnets";
import {
  AuthenticationRequiredError,
  requireUser,
} from "@/lib/auth/session-store";

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET() {
  let user;
  try {
    user = await requireUser();
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) {
      if (!isAlchemyEvmMainnetConfigured()) {
        return json({
          status: "not-connected",
          message: "not connected — API key required",
          authenticated: false,
          allowlistAvailable: false,
          networks: [],
        }, 503);
      }
      return json({ error: "Authentication required." }, 401);
    }
    if (!isAlchemyEvmMainnetConfigured()) {
      return json({ status: "not-connected", message: "not connected — API key required", authenticated: false, allowlistAvailable: false, networks: [] }, 503);
    }
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

    await prisma.auditEvent.create({
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
        message: "not connected — API key required",
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
      const balances = await readEvmMainnetPortfolio(network.chainId, user.address!, network.contracts);
      return {
        ...network,
        status: balances.status,
        nativeBalance: balances.status === "available" ? balances.nativeBalance : null,
        tokens: balances.status === "available" ? balances.tokens : network.contracts.map((contractAddress) => ({
          contractAddress,
          status: "unavailable" as const,
          balance: null,
        })),
      };
    }));
    const anyAvailable = balanceResults.some(({ status }) => status === "available");

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
      return json({
        status: "not-connected",
        message: "not connected — API key required",
        authenticated: true,
        allowlistAvailable: false,
        networks: [],
      }, 503);
    }
    return json({
      status: isAlchemyEvmMainnetConfigured() ? "unavailable" : "not-connected",
      message: isAlchemyEvmMainnetConfigured() ? "Wallet portfolio is unavailable." : "not connected — API key required",
      authenticated: true,
      allowlistAvailable: false,
      networks: [],
    }, 503);
  }
}