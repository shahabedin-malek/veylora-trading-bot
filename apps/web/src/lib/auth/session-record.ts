import { randomBytes } from "node:crypto";

/**
 * A session as a row, with the rules around it kept pure.
 *
 * Sessions used to be stateless: the signed cookie named the account and the
 * account's `sessionVersion`, which answers "is this cookie still the account's
 * current cookie?" and nothing else. It cannot answer "which devices are signed
 * in?" or "end that one", so the cookie now also names a row here, and every
 * request resolves it.
 *
 * What lives in this module and why:
 *   * `describeDevice` — a label the owner recognises in the list. Derived from
 *     the User-Agent on the server, in one place, so every row reads the same way
 *     and the raw header is kept beside it as the evidence behind the label.
 *   * `sessionIsUsable` — the one rule that makes per-session revocation real:
 *     a revoked row, an expired row, or a row belonging to a different account
 *     does not resolve. It is shared by the session list and the request path, so
 *     what the list promises and what a request honours cannot drift apart.
 *   * `revokeSessionById` / `revokeOtherSessions` — the two operations, against an
 *     injected store, so they are exercised without a server and the route keeps
 *     owning its transaction.
 */

export type SessionRecordRow = {
  id: string;
  userId: string;
  deviceLabel: string;
  userAgent: string | null;
  ipAddress: string | null;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  /** When a two-factor code was last accepted *in this session* (phase 10). */
  totpVerifiedAt: Date | null;
  /** The time step that code came from, so one reading cannot be replayed here. */
  totpLastStep: number | null;
  revokedAt: Date | null;
  revokedReason: string | null;
};

export type SessionUsability = "active" | "revoked" | "expired" | "foreign";

/** Ids are opaque and unguessable: they travel in a cookie, and the list shows them. */
export function createSessionId(): string {
  return randomBytes(16).toString("hex");
}

/**
 * Two labels from one header: the browser and the platform, in the owner's words.
 *
 * Deliberately coarse. Anything more specific ("Chrome 141.0.7390") reads as
 * precision the header does not actually carry, and the raw header is stored
 * beside the label for anyone who needs to look. An unrecognised client is named
 * as unrecognised rather than guessed at.
 */
export function describeDevice(userAgent: string | null | undefined): { label: string; browser: string; platform: string } {
  const header = (userAgent ?? "").trim();
  if (!header) return { label: "Unrecognised client", browser: "Unknown client", platform: "Unknown system" };

  const browser =
    /\bEdg\//.test(header) ? "Edge"
    : /\bOPR\/|\bOpera\b/.test(header) ? "Opera"
    : /\bFirefox\//.test(header) ? "Firefox"
    : /\bChrome\/|\bCriOS\//.test(header) ? "Chrome"
    : /\bSafari\//.test(header) ? "Safari"
    : /\bcurl\//.test(header) ? "curl"
    : /^node\b|node-fetch|undici/i.test(header) ? "a scripted client"
    : "an unrecognised client";

  const system =
    /\bAndroid\b/i.test(header) ? "Android"
    : /\biPhone\b|\biPad\b|\biOS\b/.test(header) ? "iOS"
    : /\bWindows\b/.test(header) ? "Windows"
    : /\bMacintosh\b|\bMac OS X\b/.test(header) ? "macOS"
    : /\bCrOS\b/.test(header) ? "ChromeOS"
    : /\bLinux\b/.test(header) ? "Linux"
    : "an unknown system";

  // A wallet's own browser is named as such — "MetaMask Mobile · iOS" is what a
  // phone user recognises — because inside one, the engine token is incidental
  // and would otherwise read as plain Chrome on a phone.
  const walletBrowser =
    /\bMetaMaskMobile\b|\bMetaMask\/Mobile\b|\bMetaMask\b/i.test(header) ? "MetaMask"
    : /\bCoinbaseWallet\b|\bCoinbaseBrowser\b/i.test(header) ? "Coinbase Wallet"
    : /\bRainbowMobile\b|\bRainbow\b/i.test(header) ? "Rainbow"
    : null;

  if (walletBrowser) {
    const platform = walletBrowser === "MetaMask" && /Mobile/i.test(header) ? "MetaMask Mobile" : walletBrowser;
    return { label: `${platform} · ${system}`, browser, platform };
  }

  return { label: `${browser} on ${system}`, browser, platform: system };
}

/**
 * Whether a stored row still signs anyone in.
 *
 * `foreign` is a distinguishing case rather than a plain false: a cookie that
 * names someone else's session is a different event from one that names a
 * revoked session, and the request path reports them differently.
 */
export function sessionIsUsable(
  row: SessionRecordRow | null,
  input: { userId: string; now: Date },
): SessionUsability {
  if (!row) return "revoked";
  if (row.userId !== input.userId) return "foreign";
  if (row.revokedAt) return "revoked";
  if (row.expiresAt.getTime() <= input.now.getTime()) return "expired";
  return "active";
}

/** What the session list renders. No token, no secret — a row is not a credential. */
export type SessionSummary = {
  id: string;
  deviceLabel: string;
  userAgent: string | null;
  ipAddress: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  status: "ACTIVE" | "REVOKED" | "EXPIRED";
  isCurrent: boolean;
};

export function summariseSession(row: SessionRecordRow, input: { currentSessionId: string | null; now: Date }): SessionSummary {
  return {
    id: row.id,
    deviceLabel: row.deviceLabel,
    userAgent: row.userAgent,
    ipAddress: row.ipAddress,
    createdAt: row.createdAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    status: sessionIsUsable(row, { userId: row.userId, now: input.now }) === "active"
      ? "ACTIVE"
      : row.revokedAt
        ? "REVOKED"
        : "EXPIRED",
    isCurrent: row.id === input.currentSessionId,
  };
}

/**
 * The store a revocation needs, with the transaction left to the caller.
 *
 * `recordAudit` is separate from the mutation so both happen inside one
 * transaction: a revocation that is not on the trail must not have happened, and
 * the trail is written for the *actor* — the reason is theirs, not the row's.
 */
export type SessionRecordStore = {
  findSession: (sessionId: string) => Promise<SessionRecordRow | null>;
  listSessions: (userId: string) => Promise<SessionRecordRow[]>;
  revokeSession: (input: { sessionId: string; at: Date; reason: string }) => Promise<boolean>;
  revokeSessionsExcept: (input: { userId: string; keepSessionId: string; at: Date; reason: string }) => Promise<string[]>;
  recordAudit: (input: {
    actorUserId: string;
    action: string;
    objectId: string;
    reason: string;
    detail?: Record<string, unknown>;
  }) => Promise<void>;
};

export type SessionRevocationOutcome =
  | { revoked: true; sessionId: string; deviceLabel: string }
  | { revoked: false; reason: "NOT_FOUND" | "NOT_YOURS" | "ALREADY_REVOKED" };

/**
 * End one device.
 *
 * The row is marked, never deleted: the trail has to be able to name what ended,
 * and a deleted row would make "was this device signed in?" unanswerable
 * afterwards. Because the request path resolves this row on every use, the
 * session stops on its *next* request — there is nothing to invalidate in a
 * cookie, and nothing to wait for.
 */
export async function revokeSessionById(input: {
  store: SessionRecordStore;
  userId: string;
  sessionId: string;
  at: Date;
  reason: string;
}): Promise<SessionRevocationOutcome> {
  const row = await input.store.findSession(input.sessionId);
  if (!row) return { revoked: false, reason: "NOT_FOUND" };
  if (row.userId !== input.userId) return { revoked: false, reason: "NOT_YOURS" };
  if (row.revokedAt) return { revoked: false, reason: "ALREADY_REVOKED" };

  const revoked = await input.store.revokeSession({ sessionId: row.id, at: input.at, reason: input.reason });
  if (!revoked) return { revoked: false, reason: "ALREADY_REVOKED" };
  await input.store.recordAudit({
    actorUserId: input.userId,
    action: "AUTH_SESSION_REVOKED",
    objectId: row.id,
    reason: input.reason,
    detail: { deviceLabel: row.deviceLabel, ipAddress: row.ipAddress ?? null },
  });
  return { revoked: true, sessionId: row.id, deviceLabel: row.deviceLabel };
}

/**
 * End every device except this one.
 *
 * Only the *other* rows are marked, and the current session's cookie is left
 * exactly as it is: the cookie is a pointer to a row, so ending the rows it does
 * not point at cannot end it. Each revoked row is audited, because "which devices
 * were ended by this action" is the question the owner will ask.
 */
export async function revokeOtherSessions(input: {
  store: SessionRecordStore;
  userId: string;
  keepSessionId: string;
  at: Date;
  reason: string;
}): Promise<{ revokedSessionIds: string[] }> {
  const current = await input.store.findSession(input.keepSessionId);
  if (!current || current.userId !== input.userId) {
    // Without a live current session there is no "other": ending everything would
    // be a different action than the one the owner asked for, so this refuses.
    return { revokedSessionIds: [] };
  }

  const revokedSessionIds = await input.store.revokeSessionsExcept({
    userId: input.userId,
    keepSessionId: input.keepSessionId,
    at: input.at,
    reason: input.reason,
  });
  if (revokedSessionIds.length > 0) {
    await input.store.recordAudit({
      actorUserId: input.userId,
      action: "AUTH_SESSIONS_REVOKED_OTHERS",
      objectId: input.userId,
      reason: input.reason,
      detail: { keptSessionId: input.keepSessionId, revokedCount: revokedSessionIds.length },
    });
  }
  return { revokedSessionIds };
}

/** Rows the list shows: newest activity first, revoked and expired ones included. */
export function sortSessionsForList(rows: SessionRecordRow[]): SessionRecordRow[] {
  return [...rows].sort((left, right) => right.lastSeenAt.getTime() - left.lastSeenAt.getTime());
}
