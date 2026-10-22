import { NextRequest } from "next/server";
import { getAccessRefusal } from "@/lib/auth/access-gate";
import { requireUser } from "@/lib/auth/session-store";
import { prisma } from "@/lib/db";
import { credentialAvailability } from "@/lib/trading/read-only-credentials";
import { decryptVenueCredentials } from "@/lib/trading/credential-vault";
import {
  listWunderTradingApiProfiles,
  listWunderTradingLiveStrategies,
  listWunderTradingStrategyHistory,
} from "@/lib/wundertrading/client";
import { getWunderTradingFeatureSettings } from "@/lib/wundertrading/settings";

const VIEW_SETTINGS = {
  profiles: "apiProfilesEnabled",
  live: "liveStrategiesEnabled",
  history: "strategyHistoryEnabled",
} as const;

type WunderTradingView = keyof typeof VIEW_SETTINGS;

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

function authErrorResponse(error: unknown) {
  const refusal = getAccessRefusal(error);
  return refusal ? json({ error: refusal.error }, refusal.status) : null;
}

export async function GET(request: NextRequest) {
  let user;
  try {
    user = await requireUser();
  } catch (error) {
    return authErrorResponse(error) ?? json({ error: "User authorization is unavailable." }, 503);
  }

  const viewValue = request.nextUrl.searchParams.get("view");
  const credentialId = request.nextUrl.searchParams.get("credentialId");
  if (!viewValue || !Object.prototype.hasOwnProperty.call(VIEW_SETTINGS, viewValue) || !credentialId?.trim()) {
    return json({ error: "A supported read view and credential are required." }, 400);
  }
  const view = viewValue as WunderTradingView;
  const settings = await getWunderTradingFeatureSettings().catch(() => null);
  if (!settings) return json({ error: "WunderTrading settings are unavailable." }, 503);
  if (!settings[VIEW_SETTINGS[view]]) return json({ error: "This WunderTrading read function is switched off in Access & Integrations." }, 403);

  const credential = await prisma.tradingVenueCredential.findFirst({
    where: { id: credentialId, userId: user.id, venue: "wundertrading" },
    select: {
      revokedAt: true,
      credentialCiphertext: true,
      credentialIv: true,
      credentialAuthTag: true,
    },
  });
  if (!credential) return json({ error: "WunderTrading credential was not found." }, 404);
  // A revoked key stops being used on the next request — decided in one place, so this
  // route does not carry its own copy of the rule.
  const availability = credentialAvailability(credential);
  if (!availability.available) return json(availability.body, availability.status);

  try {
    const material = decryptVenueCredentials("wundertrading", {
      ciphertext: credential.credentialCiphertext,
      iv: credential.credentialIv,
      authTag: credential.credentialAuthTag,
      fingerprint: "",
    });
    const data = view === "profiles"
      ? await listWunderTradingApiProfiles(material)
      : view === "live"
        ? await listWunderTradingLiveStrategies(material)
        : await listWunderTradingStrategyHistory(material);
    return json({ view, data });
  } catch {
    return json({ error: "WunderTrading data could not be read." }, 502);
  }
}