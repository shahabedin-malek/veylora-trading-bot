import { NextRequest } from "next/server";
import { getAuthConfig, getAuthUnavailableReason } from "@/lib/auth/config";

export async function GET(request: NextRequest) {
  const config = getAuthConfig();
  const requestHost = request.headers.get("host");
  const hostMatches = !!config && requestHost === config.domain;
  const enabled = !!config && hostMatches;

  return Response.json(
    {
      enabled,
      allowedChainIds: enabled ? [...config.allowedChainIds] : [],
      reason: enabled ? null : config && !hostMatches ? "Request host does not match APP_BASE_URL." : getAuthUnavailableReason(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
