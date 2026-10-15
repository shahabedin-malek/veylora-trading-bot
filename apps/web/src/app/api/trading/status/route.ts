import { getTradingStatus } from "@/lib/trading/status";

export async function GET() {
  return Response.json(await getTradingStatus(), {
    headers: { "Cache-Control": "no-store" },
  });
}