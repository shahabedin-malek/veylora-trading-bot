import { sessionMatchesUser, type SessionClaims } from "@/lib/auth/session-token";

/**
 * Signing out, as a function with its database behind a port.
 *
 * The route was twelve lines of Prisma inside a request handler, so the only
 * way to prove that sign-out actually ends the session server-side was to run a
 * server. The work is now here, against an injected store, and
 * `session/route.ts` supplies those three calls from its transaction. The test
 * drives this function with a fake store and then asks the *production* rule
 * (`sessionMatchesUser`) whether the cookie it signed out with still resolves —
 * which is the thing the Definition of Done asks to be proven.
 *
 * What signing out does, and why it is enough:
 *   1. it refuses a cookie that is already stale, so signing out twice is not
 *      two version bumps;
 *   2. it increments the account's `sessionVersion`, which every page and route
 *      compares the cookie against — so a cookie captured before sign-out stops
 *      resolving even though its signature is still valid;
 *   3. it records the act on the audit trail.
 *
 * The cookie itself is cleared by the route, because only a request can set a
 * response header. Clearing it is the courtesy; the version bump is the
 * invalidation.
 */

export type SessionRevocationStore = {
  findUser: (userId: string) => Promise<{ id: string; status: string; sessionVersion: number } | null>;
  /** Returns the account's version *after* the increment. */
  incrementSessionVersion: (userId: string) => Promise<number>;
  recordSignOut: (input: { userId: string; sessionVersion: number; at: Date }) => Promise<void>;
};

export type SessionRevocation =
  | { revoked: true; userId: string; sessionVersion: number }
  | { revoked: false; reason: "STALE_SESSION" | "ACCOUNT_UNAVAILABLE" };

export async function revokeSession(input: {
  store: SessionRevocationStore;
  claims: SessionClaims;
  now: Date;
}): Promise<SessionRevocation> {
  const user = await input.store.findUser(input.claims.userId);
  if (!user) return { revoked: false, reason: "ACCOUNT_UNAVAILABLE" };
  // A cookie that no longer matches this account is already invalid: bumping
  // the version for it would sign out whatever session is legitimately current.
  if (!sessionMatchesUser(input.claims, user)) return { revoked: false, reason: "STALE_SESSION" };

  const sessionVersion = await input.store.incrementSessionVersion(user.id);
  await input.store.recordSignOut({ userId: user.id, sessionVersion, at: input.now });
  return { revoked: true, userId: user.id, sessionVersion };
}
