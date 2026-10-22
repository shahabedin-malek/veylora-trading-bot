import { NextRequest } from "next/server";
import { getAuthConfig, isSameOriginRequest } from "@/lib/auth/config";
import { authenticationGapResponse, getAccessRefusal } from "@/lib/auth/access-gate";
import { requireUser } from "@/lib/auth/session-store";
import { describeDepositAddress } from "@/lib/deposits/service";
import { requireDepositAddress } from "@/lib/deposits/api";

/**
 * `GET /api/deposits/[address]` — one deposit address, and everything that
 * arrived at it.
 *
 * The address in the path is a *lookup key*, never an authorization: the row is
 * found among the addresses issued to the signed-in account, so another owner's
 * address — which is public on chain and therefore guessable — answers 404 with
 * a sentence rather than exposing their deposits.
 *
 * The whole reason this route exists separately from `/api/deposits` is the
 * mobile click-path: a phone that has the address in a wallet can ask for it by
 * value, and the answer carries the confirmations remaining per row.
 */

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

function authError(error: unknown) {
  const refusal = getAccessRefusal(error);
  return refusal ? json({ error: refusal.error }, refusal.status) : null;
}

export async function GET(request: NextRequest, context: RouteContext<"/api/deposits/[address]">) {
  const config = getAuthConfig();
  if (!config) return authenticationGapResponse();
  if (!isSameOriginRequest(request, config)) return json({ error: "Request origin is not allowed." }, 403);

  let user;
  try {
    user = await requireUser();
  } catch (error) {
    return authError(error) ?? json({ error: "Deposits are unavailable." }, 503);
  }

  const { address } = await context.params;
  const refusal = requireDepositAddress(address);
  if (refusal) return json({ error: refusal.error }, refusal.status);

  try {
    const result = await describeDepositAddress({ userId: user.id, address });
    if (!result.found || !result.address) {
      return json(
        { error: "That address is not a deposit address issued to this account." },
        404,
      );
    }

    return json({
      address: {
        network: result.address.network,
        address: result.address.address,
        chainId: result.address.chainId,
        derivationPath: `m/44'/60'/0'/0/${result.address.derivationIndex}`,
        issuedAt: result.address.createdAt,
      },
      network: result.network
        ? {
            slug: result.network.slug,
            displayName: result.network.displayName,
            chainId: result.network.chainId,
            testnet: result.network.testnet,
            nativeSymbol: result.network.nativeSymbol,
            status: result.network.status,
            confirmationsRequired: result.network.confirmations,
            minimumAmount: result.network.minimumAmount,
            missing: result.network.missing,
            problems: result.network.problems,
            token: result.network.token,
          }
        : null,
      deposits: result.deposits.map((deposit) => ({
        ...deposit,
        confirmationsRequired: result.network?.confirmations ?? 0,
        confirmationsRemaining: Math.max(0, (result.network?.confirmations ?? 0) - deposit.confirmations),
      })),
    });
  } catch {
    return json({ error: "Deposits are unavailable." }, 503);
  }
}
