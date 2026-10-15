import { timingSafeEqual } from "node:crypto";
import { evaluateActiveMarketAlerts } from "@/lib/alerts/evaluate";

function hasValidCronAuthorization(request: Request, secret: string | undefined): boolean {
  if (!secret) return false;
  const authorization = request.headers.get("authorization");
  if (!authorization) return false;
  const expected = Buffer.from(`Bearer ${secret}`, "utf8");
  const supplied = Buffer.from(authorization, "utf8");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export async function handleMarketAlertsCron(
  request: Request,
  evaluate: typeof evaluateActiveMarketAlerts = evaluateActiveMarketAlerts,
): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret?.trim()) return Response.json({ error: "Alert scheduler is not configured." }, { status: 503 });
  if (!hasValidCronAuthorization(request, secret)) return Response.json({ error: "Unauthorized." }, { status: 401 });

  try {
    return Response.json(await evaluate(), { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "Alert evaluation failed; no trigger was reported." }, { status: 503 });
  }
}

export async function GET(request: Request) {
  return handleMarketAlertsCron(request);
}