import { NextResponse, type NextRequest } from "next/server";
import { REQUEST_ID_HEADER, REQUEST_ROUTE_HEADER, normalizeRoute, requestIdFor } from "@/lib/observability/request-id";

/**
 * Every request leaves with an id in its response headers, and arrives at the
 * server code that logs about it carrying the same id.
 *
 * This is deliberately the only place an id is minted. A route that generated
 * its own would disagree with the header the caller can see, which is exactly
 * the trace a user report depends on. An inbound `x-request-id` is honoured only
 * when it looks like an id (see `normalizeRequestId`), so a caller cannot forge
 * one or write arbitrary text into the records.
 *
 * `proxy.ts` is Next 16's name for this file convention (it was `middleware.ts`).
 * It runs in the Edge runtime: it imports nothing from `node:*`.
 */
export function proxy(request: NextRequest) {
  const requestId = requestIdFor(request.headers.get(REQUEST_ID_HEADER));
  const headers = new Headers(request.headers);
  headers.set(REQUEST_ID_HEADER, requestId);
  // The path the handler will see, so a stored record or a log line can name
  // the route it belongs to without the handler re-deriving it.
  headers.set(REQUEST_ROUTE_HEADER, normalizeRoute(request.nextUrl.pathname) ?? "/");

  const response = NextResponse.next({ request: { headers } });
  response.headers.set(REQUEST_ID_HEADER, requestId);
  return response;
}

export const config = {
  /**
   * Everything but the build output and static files. Those are served without
   * touching a route handler, so an id on them would be noise.
   */
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff|woff2|ttf|txt|xml|json)$).*)"],
};
