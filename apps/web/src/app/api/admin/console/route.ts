import { NextRequest } from "next/server";
import { accessRefusalPayload, authenticationGapResponse, getAccessRefusal } from "@/lib/auth/access-gate";
import { requireSitePermission } from "@/lib/auth/session-store";
import { parseAdminConsoleQuery } from "@/lib/admin/views";
import { listAdminSection } from "@/lib/admin/queries";

/**
 * One section of the admin console.
 *
 * The query is parsed by the shared vocabulary in `views.ts`, so an unknown
 * section or a column that does not exist is a 400 naming what is available
 * rather than a silently empty table.
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

  const search = new URL(request.url).searchParams;
  const parsed = parseAdminConsoleQuery(Object.fromEntries(search.entries()));
  if (!parsed.valid) return json({ error: parsed.error }, 400);

  try {
    return json(await listAdminSection(parsed.section, parsed.filters, parsed.columns));
  } catch {
    return json(
      {
        error: `${parsed.section.label} could not be read from the database, so it is shown as unavailable rather than empty.`,
      },
      503,
    );
  }
}
