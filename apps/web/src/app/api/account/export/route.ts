import { NextRequest } from "next/server";
import { authenticationGapResponse, getAccessRefusal } from "@/lib/auth/access-gate";
import { getAuthConfig } from "@/lib/auth/config";
import { requireUser } from "@/lib/auth/session-store";
import { parseHistoryFilter } from "@/lib/portfolio/pnl";
import { exportBody, readAccountView } from "@/lib/portfolio/service";

/**
 * The download: the same rows the account screen shows, as a file.
 *
 * It exists as its own route for one reason — a link that downloads should look like
 * a download, and a browser only names a file from a `Content-Disposition` header it
 * would not want on the page's own JSON (`/api/account?format=csv` serves the same
 * body inline for scripts). Both routes call {@link exportBody} on the same view, so
 * "the export reconciles to the screen" is a property of there being one body builder
 * rather than of two renderers agreeing.
 *
 * No approval, no confirmation and no second step: an export is a read of the owner's
 * own numbers, and the phase's own "do not do" is explicit that nothing may stand in
 * front of it. The filters are the screen's filters, so an export is always the export
 * *of what is on screen* rather than of everything.
 *
 * The file is never cached: a downloaded balance is a claim about money at a moment.
 */

function authError(error: unknown) {
  const refusal = getAccessRefusal(error);
  return refusal
    ? Response.json({ error: refusal.error }, { status: refusal.status, headers: { "Cache-Control": "no-store" } })
    : null;
}

function problem(error: string, status = 400) {
  return Response.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET(request: NextRequest) {
  const config = getAuthConfig();
  if (!config) return authenticationGapResponse();

  let user;
  try {
    user = await requireUser();
  } catch (error) {
    return authError(error) ?? problem("The export is unavailable.", 503);
  }

  const search = new URL(request.url).searchParams;
  const parsed = parseHistoryFilter(
    {
      from: search.get("from"),
      to: search.get("to"),
      asset: search.get("asset"),
      type: search.get("type"),
      hash: search.get("hash"),
    },
    new Date(),
  );
  if (!parsed.valid) return problem(parsed.error);

  const requested = (search.get("format") ?? "csv").trim().toLowerCase();
  if (requested !== "csv" && requested !== "json") {
    return problem(`Unknown export format ${JSON.stringify(requested)}. Use csv or json.`);
  }

  try {
    const view = await readAccountView({ userId: user.id, filter: parsed.filter });
    const exported = exportBody(view, requested);
    return new Response(exported.body, {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": exported.contentType,
        "Content-Disposition": `attachment; filename="${exported.filename}"`,
        // The totals the file carries, on the response as well, so a script can check
        // the file against the screen without parsing it first.
        "X-Veylora-Rows": String(view.overview.history.length),
      },
    });
  } catch {
    return problem("The export could not be built.", 503);
  }
}
