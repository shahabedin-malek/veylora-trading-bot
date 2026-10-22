import { NextRequest } from "next/server";
import { accessRefusalPayload, authenticationGapResponse, getAccessRefusal } from "@/lib/auth/access-gate";
import { requireSitePermission } from "@/lib/auth/session-store";
import { classifyAdminSearch } from "@/lib/admin/views";
import { searchAdmin } from "@/lib/admin/queries";

/**
 * Cross-entity search: a wallet, a transaction hash, a user id or an order id.
 *
 * The classification only describes what the term looks like; the read still
 * searches every entity, because one string can legitimately name more than one
 * record and narrowing before the lookup would hide the others.
 */

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET(request: NextRequest) {
  try {
    await requireSitePermission("admin.console.read");
  } catch (error) {
    const refusal = getAccessRefusal(error);
    return refusal ? json(accessRefusalPayload(refusal), refusal.status) : authenticationGapResponse();
  }

  const q = new URL(request.url).searchParams.get("q") ?? "";
  if (q.trim().length < 2) {
    return json({ error: "Search needs at least two characters." }, 400);
  }
  if (q.length > 160) return json({ error: "Search terms are capped at 160 characters." }, 400);

  try {
    const matches = await searchAdmin(q);
    return json({ q, interpretedAs: classifyAdminSearch(q), matches, count: matches.length });
  } catch {
    return json({ error: "Search could not read the database." }, 503);
  }
}
