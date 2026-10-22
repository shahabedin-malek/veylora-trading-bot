import { AsyncLocalStorage } from "node:async_hooks";
import { createLogger, type Logger } from "@/lib/observability/logger";
import { normalizeRequestId, normalizeRoute, REQUEST_ID_HEADER, REQUEST_ROUTE_HEADER } from "@/lib/observability/request-id";

/**
 * The id, the route and the logger a request shares with everything it calls.
 *
 * `src/middleware.ts` attaches the id to the request and the response, which
 * covers every request. This module is the server half: code that logs or
 * records a provider call asks for the *current* context rather than taking an
 * id as an argument, so a new call site cannot forget to pass one and silently
 * produce an uncorrelated record.
 *
 * Resolution order:
 *  1. the context pinned by {@link runWithRequestContext} — how a test, or code
 *     that owns a whole request, states the context explicitly;
 *  2. the request headers the middleware set;
 *  3. nothing, which returns null rather than an invented id. A log line with
 *     no request id is honest; a fabricated one would point at the wrong trace.
 */

export type RequestContext = {
  requestId: string;
  route: string | null;
  logger: Logger;
};

const storage = new AsyncLocalStorage<RequestContext>();

export function contextFrom(input: { requestId: string; route?: string | null }): RequestContext {
  const requestId = input.requestId;
  const route = normalizeRoute(input.route) ?? null;
  return {
    requestId,
    route,
    logger: createLogger({ requestId, route, bindings: { route } }),
  };
}

/** Pin a context for the duration of `fn`, so nested calls share it. */
export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

/** The context this call chain belongs to, when one was pinned. */
export function currentRequestContext(): RequestContext | null {
  return storage.getStore() ?? null;
}

/** The context as the middleware left it on this request's headers. */
export async function requestContextFromHeaders(): Promise<RequestContext | null> {
  let headerList: { get(name: string): string | null };
  try {
    // Imported lazily so a module that records provider calls can be used by a
    // script or a unit test that never enters a Next request at all.
    const nextHeaders = await import("next/headers");
    headerList = await nextHeaders.headers();
  } catch {
    // Outside a request scope (a build-time prerender, a script, a test) there
    // are no request headers to read. That is not an error worth logging.
    return null;
  }
  const requestId = normalizeRequestId(headerList.get(REQUEST_ID_HEADER));
  if (!requestId) return null;
  return contextFrom({ requestId, route: headerList.get(REQUEST_ROUTE_HEADER) });
}

/** The context for this call: pinned first, then the request's own headers. */
export async function resolveRequestContext(): Promise<RequestContext | null> {
  return currentRequestContext() ?? (await requestContextFromHeaders());
}

/**
 * A logger for code that may run outside any request (a script, a prerender).
 * It keeps the request id and route null instead of guessing them.
 */
export function loggerFor(route: string | null = null): Logger {
  const context = currentRequestContext();
  if (context) return context.logger;
  return createLogger({ route: normalizeRoute(route) ?? null });
}
