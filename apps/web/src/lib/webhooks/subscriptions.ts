import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/db";
import { openSecret, sealSecret } from "@/lib/signals/verify";

/**
 * Outbound webhook subscriptions (phase 31).
 *
 * A subscription is (owner, endpoint, event type, secret). The secret belongs to the endpoint
 * rather than the account so two receivers cannot verify each other's deliveries, and revoking
 * one endpoint cannot invalidate another.
 *
 * The rules enforced here rather than in the route:
 *
 *  - **The event type is one we emit.** A subscription to a name nothing publishes is a
 *    promise this build cannot keep, so it is refused at creation with the known list.
 *  - **The URL is http(s), has no credentials in it, and is https unless it is loopback.**
 *    A local receiver is the documented development case; sending a signed payload over plain
 *    http to a public host is not something an owner should be able to switch on by accident.
 *  - **The secret is generated here, sealed, and returned exactly once.** Listing a
 *    subscription never selects the sealed columns, which is what makes "the secret is never
 *    returned by an API" a property of the query rather than a promise in a comment.
 */

export const WEBHOOK_EVENT_TYPES = [
  "trade.placed",
  "alert.triggered",
  "strategy.decision",
  "webhook.test",
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export const WEBHOOK_SUBSCRIPTION_CAP = 10;
export const WEBHOOK_SECRET_PREFIX = "whsec_";

export function isWebhookEventType(value: unknown): value is WebhookEventType {
  return typeof value === "string" && (WEBHOOK_EVENT_TYPES as readonly string[]).includes(value);
}

export function generateWebhookSecret(): string {
  return `${WEBHOOK_SECRET_PREFIX}${randomBytes(32).toString("base64url")}`;
}

export type WebhookUrlValidation = { ok: true; url: string } | { ok: false; message: string };

/** Is this host the local machine? Loopback is the only place plain http is allowed. */
function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

export function validateWebhookUrl(value: unknown): WebhookUrlValidation {
  if (typeof value !== "string" || !value.trim()) return { ok: false, message: "A receiver URL is required." };
  const trimmed = value.trim();
  if (trimmed.length > 2_048) return { ok: false, message: "The receiver URL is longer than 2048 characters." };
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, message: "The receiver URL is not a valid absolute URL." };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, message: "The receiver URL must use http or https." };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, message: "The receiver URL must not carry credentials; the signature is the credential." };
  }
  if (parsed.protocol === "http:" && !isLoopback(parsed.hostname)) {
    return {
      ok: false,
      message: "A public receiver must use https; plain http is accepted only for localhost.",
    };
  }
  return { ok: true, url: parsed.toString() };
}

export type WebhookSubscriptionView = {
  id: string;
  label: string;
  url: string;
  eventType: string;
  active: boolean;
  health: string;
  consecutiveFailures: number;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  createdAt: string;
};

const VIEW_SELECT = {
  id: true,
  label: true,
  url: true,
  eventType: true,
  active: true,
  health: true,
  consecutiveFailures: true,
  lastAttemptAt: true,
  lastSuccessAt: true,
  lastError: true,
  createdAt: true,
} as const;

type ViewRow = {
  id: string;
  label: string;
  url: string;
  eventType: string;
  active: boolean;
  health: string;
  consecutiveFailures: number;
  lastAttemptAt: Date | null;
  lastSuccessAt: Date | null;
  lastError: string | null;
  createdAt: Date;
};

function toView(row: ViewRow): WebhookSubscriptionView {
  return {
    id: row.id,
    label: row.label,
    url: row.url,
    eventType: row.eventType,
    active: row.active,
    health: row.health,
    consecutiveFailures: row.consecutiveFailures,
    lastAttemptAt: row.lastAttemptAt?.toISOString() ?? null,
    lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
    lastError: row.lastError,
    createdAt: row.createdAt.toISOString(),
  };
}

export type CreateWebhookResult =
  | { ok: true; subscription: WebhookSubscriptionView; secret: string }
  | { ok: false; status: number; message: string };

/**
 * Create one subscription. The returned secret is the only time it exists outside this call:
 * the caller renders it once and the row keeps only its sealed form.
 */
export async function createWebhookSubscription(input: {
  userId: string;
  url: unknown;
  eventType: unknown;
  label?: unknown;
}): Promise<CreateWebhookResult> {
  const url = validateWebhookUrl(input.url);
  if (!url.ok) return { ok: false, status: 400, message: url.message };
  if (!isWebhookEventType(input.eventType)) {
    return {
      ok: false,
      status: 400,
      message: `The event type must be one of ${WEBHOOK_EVENT_TYPES.join(", ")}.`,
    };
  }
  const count = await prisma.webhookSubscription.count({ where: { userId: input.userId, revokedAt: null } });
  if (count >= WEBHOOK_SUBSCRIPTION_CAP) {
    return {
      ok: false,
      status: 409,
      message: `This account already has ${count} of ${WEBHOOK_SUBSCRIPTION_CAP} webhook endpoints, the cap this build allows. Revoke one to add another.`,
    };
  }

  const secret = generateWebhookSecret();
  const sealed = sealSecret("webhook", secret);
  const label = typeof input.label === "string" && input.label.trim()
    ? input.label.trim().slice(0, 80)
    : `${input.eventType} → ${new URL(url.url).host}`;

  const created = await prisma.webhookSubscription.create({
    data: {
      userId: input.userId,
      label,
      url: url.url,
      eventType: input.eventType,
      secretCiphertext: sealed.ciphertext,
      secretIv: sealed.iv,
      secretAuthTag: sealed.authTag,
    },
    select: VIEW_SELECT,
  });
  return { ok: true, subscription: toView(created), secret };
}

export async function listWebhookSubscriptions(userId: string): Promise<WebhookSubscriptionView[]> {
  const rows = await prisma.webhookSubscription.findMany({
    where: { userId, revokedAt: null },
    orderBy: { createdAt: "desc" },
    select: VIEW_SELECT,
  });
  return rows.map(toView);
}

/** The endpoints an event is delivered to. Active and not revoked only. */
export async function activeSubscriptionsFor(userId: string, eventType: string) {
  return prisma.webhookSubscription.findMany({
    where: { userId, eventType, active: true, revokedAt: null },
    select: { id: true, url: true, label: true },
  });
}

/** Set one endpoint active or paused. Pausing never deletes the delivery history. */
export async function setWebhookActive(userId: string, id: string, active: boolean): Promise<boolean> {
  const result = await prisma.webhookSubscription.updateMany({
    where: { id, userId, revokedAt: null },
    data: { active },
  });
  return result.count === 1;
}

/** Revoke: no further deliveries, history retained. */
export async function revokeWebhookSubscription(userId: string, id: string): Promise<boolean> {
  const result = await prisma.webhookSubscription.updateMany({
    where: { id, userId, revokedAt: null },
    data: { active: false, revokedAt: new Date() },
  });
  return result.count === 1;
}

/**
 * The sealed secret for one endpoint, opened for signing. Internal to dispatch: it is never
 * selected by a view, never returned by a route and never logged.
 */
export async function webhookSecretFor(subscriptionId: string): Promise<string | null> {
  const row = await prisma.webhookSubscription.findUnique({
    where: { id: subscriptionId },
    select: { secretCiphertext: true, secretIv: true, secretAuthTag: true, revokedAt: true },
  });
  if (!row || row.revokedAt) return null;
  return openSecret("webhook", {
    ciphertext: row.secretCiphertext,
    iv: row.secretIv,
    authTag: row.secretAuthTag,
  });
}
