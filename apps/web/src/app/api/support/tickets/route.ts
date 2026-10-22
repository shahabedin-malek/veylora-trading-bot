import { accessRefusalPayload, authenticationGapResponse, getAccessRefusal } from "@/lib/auth/access-gate";
import { requireUser } from "@/lib/auth/session-store";
import { listTicketsForUser } from "@/lib/support/repository";

/**
 * The account's own tickets.
 *
 * This is the only support endpoint an account can reach, and it is scoped by the
 * session's own id. `listTicketsForUser` selects PUBLIC messages in SQL and then
 * passes them through `userTicketView`, which drops anything else again; internal
 * notes live in a table this path never queries. `tests/support-crm.test.ts`
 * proves a mixed thread comes back without its internal row, and the admin
 * timeline is the surface that does show it.
 */

function json(data: unknown, status = 200) {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "private, no-store", Vary: "Cookie" },
  });
}

export async function GET() {
  let user;
  try {
    user = await requireUser();
  } catch (error) {
    const refusal = getAccessRefusal(error);
    return refusal ? json(accessRefusalPayload(refusal), refusal.status) : authenticationGapResponse();
  }
  try {
    return json({ tickets: await listTicketsForUser(user.id) });
  } catch {
    return json({ error: "Your support tickets could not be read." }, 503);
  }
}
