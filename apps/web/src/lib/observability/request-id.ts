/**
 * The correlation id every request carries.
 *
 * Kept in its own module, and free of every Node-only import, so
 * `src/middleware.ts` (Edge runtime) uses the same definitions as the server
 * code that reads them back. A second copy of the header name would be a silent
 * way for the two halves to stop matching. `globalThis.crypto` is the one
 * random source both runtimes share.
 */

/** Echoed on every response, and set on the request for the handlers below. */
export const REQUEST_ID_HEADER = "x-request-id";

/** The request path the middleware saw, so a log line can name its route. */
export const REQUEST_ROUTE_HEADER = "x-veylora-route";

/** A request id has to survive a log line, a header and a user's clipboard. */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{8,128}$/;

/** Values that would be dangerous or useless as a log field if echoed. */
const RESERVED = /^(?:null|undefined|0|none|unknown)$/i;

export function generateRequestId(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * An inbound id is honoured only when it looks like one, so a caller cannot
 * forge a log line or stuff a header into the records. Anything else is
 * replaced by a freshly generated id rather than trusted.
 */
export function normalizeRequestId(value: string | null | undefined): string | null {
  const candidate = value?.trim();
  if (!candidate || RESERVED.test(candidate) || !REQUEST_ID_PATTERN.test(candidate)) return null;
  return candidate;
}

/** The id for this request: what the caller sent when it is usable, else a new one. */
export function requestIdFor(value: string | null | undefined): string {
  return normalizeRequestId(value) ?? generateRequestId();
}

/**
 * A route label safe to store and log. The path is caller-supplied, so it is
 * length-capped and stripped of anything that could break a log line.
 */
export function normalizeRoute(value: string | null | undefined): string | null {
  const candidate = value?.trim();
  if (!candidate) return null;
  const cleaned = candidate.split("?")[0]?.slice(0, 200) ?? "";
  return cleaned && cleaned.startsWith("/") && !/[\r\n\t]/.test(cleaned) ? cleaned : null;
}
