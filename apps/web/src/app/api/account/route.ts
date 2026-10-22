import { NextRequest } from "next/server";
import { authenticationGapResponse, getAccessRefusal } from "@/lib/auth/access-gate";
import { getAuthConfig } from "@/lib/auth/config";
import { requireUser } from "@/lib/auth/session-store";
import { parseHistoryFilter } from "@/lib/portfolio/pnl";
import { accountPayload, exportBody, readAccountView } from "@/lib/portfolio/service";

/**
 * The account surface: where the money is, and everything that explains it.
 *
 * `GET` answers four questions in one response — what is held (per asset, with the
 * accounts the figures were added up from), what is held in positions and what they
 * cost and are worth, what happened in the period, and every line of history for the
 * selected filter with the totals that filter adds up to. Nothing here is stored or
 * recomputed for the client: the totals the screen shows and the totals the export
 * carries are the same array.
 *
 * Two query options are deliberate.
 *
 *  - `format=csv|json` renders the very same view as a file. It is served inline here
 *    and as an attachment from `/api/account/export`, so a page can link to a download
 *    and a script can read the body without a second implementation existing.
 *  - `external=1` additionally reads the account's **read-only** venue keys and reports
 *    what they see as external. It is opt-in because it reaches out to a venue, and it
 *    cannot change a single figure above it: the import's result is a separate value
 *    that no spendable balance is computed from.
 *
 * The read never caches: a balance is the outcome of a request, and a cached one would
 * be a stale claim about money.
 */

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

function authError(error: unknown) {
  const refusal = getAccessRefusal(error);
  return refusal ? json({ error: refusal.error }, refusal.status) : null;
}

export async function GET(request: NextRequest) {
  const config = getAuthConfig();
  if (!config) return authenticationGapResponse();

  let user;
  try {
    user = await requireUser();
  } catch (error) {
    return authError(error) ?? json({ error: "The account view is unavailable." }, 503);
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
  if (!parsed.valid) return json({ error: parsed.error }, 400);

  const format = search.get("format");

  try {
    const view = await readAccountView({
      userId: user.id,
      filter: parsed.filter,
      includeExternal: search.get("external") === "1",
    });

    if (format === "csv" || format === "json") {
      const exported = exportBody(view, format);
      return new Response(exported.body, {
        status: 200,
        headers: {
          "Cache-Control": "no-store",
          "Content-Type": exported.contentType,
          "Content-Disposition": `inline; filename="${exported.filename}"`,
        },
      });
    }

    return json(accountPayload(view));
  } catch {
    return json({ error: "The account view could not be read." }, 503);
  }
}
