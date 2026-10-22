import { NextRequest } from "next/server";
import { exportSupportTicket } from "@/lib/support/repository";
import { requireSupportCaller, supportFailure } from "@/lib/support/http";

/**
 * A ticket as a file.
 *
 * The export is the operator's own record, so it carries internal messages and
 * notes — each labelled — and every body is redacted by the builder before it is
 * serialised. `tests/support-crm.test.ts` asserts a seeded payload with a key and
 * a password in it comes out with both replaced.
 */

export async function GET(_request: NextRequest, { params }: { params: Promise<{ ticketId: string }> }) {
  const caller = await requireSupportCaller("crm.support.read");
  if (!caller.ok) return caller.response;
  const { ticketId } = await params;
  try {
    const file = await exportSupportTicket({ ticketId, exportedByUserId: caller.user.id });
    return new Response(file.content, {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": `attachment; filename="${file.filename}"`,
        "Content-Length": String(file.bytes),
      },
    });
  } catch (error) {
    return supportFailure(error, "The ticket export could not be produced.");
  }
}
