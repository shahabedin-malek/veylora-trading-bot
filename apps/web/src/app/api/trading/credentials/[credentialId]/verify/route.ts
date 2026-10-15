import { NextRequest } from "next/server";
import { getAuthConfig, getAuthUnavailableReason, isSameOriginRequest } from "@/lib/auth/config";
import { AuthenticationRequiredError, requireUser } from "@/lib/auth/session-store";
import { prisma } from "@/lib/db";
import { fetchVerifiedSpotBalances } from "@/lib/trading/exchange-balances";
import { decryptVenueCredentials, type TradingVenue } from "@/lib/trading/credential-vault";
import { listWunderTradingApiProfiles } from "@/lib/wundertrading/client";
import { getWunderTradingFeatureSettings } from "@/lib/wundertrading/settings";

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

function authErrorResponse(error: unknown) {
  if (error instanceof AuthenticationRequiredError) return json({ error: "Authentication required." }, 401);
  return null;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ credentialId: string }> },
) {
  const config = getAuthConfig();
  if (!config) return json({ error: getAuthUnavailableReason() ?? "Authentication is unavailable." }, 503);
  if (!isSameOriginRequest(request, config)) return json({ error: "Request origin is not allowed." }, 403);

  let user;
  try {
    user = await requireUser();
  } catch (error) {
    return authErrorResponse(error) ?? json({ error: "User authorization is unavailable." }, 503);
  }

  const { credentialId } = await params;
  const credential = await prisma.tradingVenueCredential.findFirst({
    where: { id: credentialId, userId: user.id, revokedAt: null },
    select: {
      id: true,
      venue: true,
      credentialCiphertext: true,
      credentialIv: true,
      credentialAuthTag: true,
    },
  });
  if (!credential) return json({ error: "Credential was not found." }, 404);
  if (credential.venue === "wundertrading") {
    const settings = await getWunderTradingFeatureSettings().catch(() => null);
    if (!settings) return json({ error: "WunderTrading settings are unavailable." }, 503);
    if (!settings.apiProfilesEnabled) return json({ error: "WunderTrading profile access is disabled by the administrator." }, 403);

    try {
      const profiles = await listWunderTradingApiProfiles(
        decryptVenueCredentials("wundertrading", {
          ciphertext: credential.credentialCiphertext,
          iv: credential.credentialIv,
          authTag: credential.credentialAuthTag,
          fingerprint: "",
        }),
      );
      const verifiedAt = new Date();
      await prisma.tradingVenueCredential.update({ where: { id: credential.id }, data: { verifiedAt } });
      return json({
        verifiedAt,
        profiles,
        ordersSubmitted: false,
        note: "This read listed WunderTrading API profiles only. It did not verify key permissions or submit an order.",
      });
    } catch {
      return json({ error: "WunderTrading profiles could not be read." }, 502);
    }
  }
  if (!(["binance", "coinbase-advanced", "kraken"] as string[]).includes(credential.venue)) {
    return json({ error: "Credential venue is unsupported." }, 400);
  }

  try {
    const balances = await fetchVerifiedSpotBalances(
      credential.venue as TradingVenue,
      decryptVenueCredentials(credential.venue as TradingVenue, {
        ciphertext: credential.credentialCiphertext,
        iv: credential.credentialIv,
        authTag: credential.credentialAuthTag,
        fingerprint: "",
      }),
    );
    const verifiedAt = new Date();
    await prisma.tradingVenueCredential.update({
      where: { id: credential.id },
      data: { verifiedAt },
    });
    return json({
      verifiedAt,
      balances,
      ordersSubmitted: false,
      note: "This check read balances only. It did not verify the venue key's permission settings or submit an order.",
    });
  } catch {
    return json({ error: "Balance access could not be verified. No order was submitted." }, 502);
  }
}