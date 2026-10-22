import { NextRequest } from "next/server";
import { renderReplyForTicket } from "@/lib/support/repository";
import { requireSupportCaller, supportFailure, supportJson } from "@/lib/support/http";

/**
 * Fill a saved reply's placeholders for one ticket.
 *
 * Every value comes from the ticket's account, the ledger and the signed-in
 * operator — never from the query string — so previewing cannot be used to write
 * another account's details into a reply about this one.
 */

export async function GET(request: NextRequest) {
  const caller = await requireSupportCaller("crm.support.read");
  if (!caller.ok) return caller.response;
  const search = new URL(request.url).searchParams;
  const replyId = search.get("replyId") ?? "";
  const ticketId = search.get("ticketId") ?? "";
  if (!replyId || !ticketId) return supportJson({ error: "A saved reply id and a ticket id are required." }, 400);
  try {
    return supportJson(await renderReplyForTicket({ replyId, ticketId, operatorUserId: caller.user.id }));
  } catch (error) {
    return supportFailure(error, "The saved reply could not be rendered.");
  }
}
