import { NextRequest } from "next/server";
import { searchSupport } from "@/lib/support/repository";
import { requireSupportCaller, supportJson } from "@/lib/support/http";

/** Search tickets, thread messages, internal notes and audit timeline content. */
export async function GET(request: NextRequest) {
  const caller = await requireSupportCaller("crm.support.read");
  if (!caller.ok) return caller.response;
  const q = new URL(request.url).searchParams.get("q") ?? "";
  if (q.trim().length < 2) return supportJson({ error: "Search needs at least two characters." }, 400);
  if (q.length > 160) return supportJson({ error: "Search terms are capped at 160 characters." }, 400);
  try {
    return supportJson(await searchSupport(q));
  } catch {
    return supportJson({ error: "Support search could not read the database." }, 503);
  }
}
