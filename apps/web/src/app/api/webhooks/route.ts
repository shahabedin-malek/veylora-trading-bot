import { NextRequest } from "next/server";
import { authErrorResponse, botJson, readJsonBody, requireBotWrite } from "@/lib/bot-builder/api";
import { requireUser } from "@/lib/auth/session-store";
import { listWebhookDeliveries, publishWebhookEvent } from "@/lib/webhooks/dispatch";
import {
  createWebhookSubscription,
  listWebhookSubscriptions,
  revokeWebhookSubscription,
  setWebhookActive,
  WEBHOOK_EVENT_TYPES,
} from "@/lib/webhooks/subscriptions";

/**
 * Outbound webhook subscriptions (phase 31).
 *
 * `GET` lists endpoints, their health and the recent attempts. The sealed secret columns are
 * not selected anywhere in this route, which is how "the webhook secret is never returned" is
 * enforced by the query rather than by remembering not to include a field.
 *
 * `POST` is one small action vocabulary on one route:
 *
 *  - `create` returns the endpoint's secret exactly once, with instructions to copy it.
 *  - `pause` / `resume` stop and restart deliveries without losing history.
 *  - `revoke` ends the endpoint for good; its delivery rows stay readable.
 *  - `test` publishes a `webhook.test` event now, so an owner can prove a receiver is wired
 *    correctly without waiting for a real trade. It is signed exactly like a real event.
 */

export async function GET() {
  let user;
  try {
    user = await requireUser();
  } catch (error) {
    return authErrorResponse(error) ?? botJson({ error: "Webhook settings are unavailable." }, 503);
  }
  try {
    const [subscriptions, deliveries] = await Promise.all([
      listWebhookSubscriptions(user.id),
      listWebhookDeliveries(user.id, 30),
    ]);
    return botJson({
      subscriptions,
      deliveries,
      eventTypes: WEBHOOK_EVENT_TYPES,
      signature:
        "Every delivery carries X-Veylora-Timestamp, X-Veylora-Delivery, X-Veylora-Event and X-Veylora-Signature: sha256=<hex>, where the HMAC-SHA256 is over `<timestamp>.<raw body>`.",
    });
  } catch {
    return botJson({ error: "Webhook settings could not be read." }, 503);
  }
}

export async function POST(request: NextRequest) {
  const session = await requireBotWrite(request);
  if ("response" in session) return session.response;
  const parsed = await readJsonBody(request);
  if ("response" in parsed) return parsed.response;
  const body = parsed.body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return botJson({ error: "A webhook action is required." }, 400);
  }
  const record = body as Record<string, unknown>;
  const action = typeof record.action === "string" ? record.action : "";

  try {
    switch (action) {
      case "create": {
        const created = await createWebhookSubscription({
          userId: session.userId,
          url: record.url,
          eventType: record.eventType,
          label: record.label,
        });
        if (!created.ok) return botJson({ error: created.message }, created.status);
        return botJson(
          {
            subscription: created.subscription,
            /** Shown once. The row keeps only the sealed form. */
            secret: created.secret,
            note: "Copy the signing secret now. It is not stored in a readable form and cannot be shown again.",
          },
          201,
        );
      }
      case "pause":
      case "resume": {
        const id = typeof record.id === "string" ? record.id.trim() : "";
        if (!id) return botJson({ error: "id is required." }, 400);
        const changed = await setWebhookActive(session.userId, id, action === "resume");
        if (!changed) return botJson({ error: "That endpoint was not found for this account." }, 404);
        return botJson({ active: action === "resume" });
      }
      case "revoke": {
        const id = typeof record.id === "string" ? record.id.trim() : "";
        if (!id) return botJson({ error: "id is required." }, 400);
        const revoked = await revokeWebhookSubscription(session.userId, id);
        if (!revoked) return botJson({ error: "That endpoint was not found for this account." }, 404);
        return botJson({ revoked: true });
      }
      case "test": {
        const result = await publishWebhookEvent({
          userId: session.userId,
          eventType: "webhook.test",
          payload: {
            message: "This is a signed test event from Veylora. No order was placed.",
            sentAt: new Date().toISOString(),
          },
        });
        return botJson({
          ...result,
          note:
            result.queued === 0
              ? "No active endpoint subscribes to webhook.test, so nothing was sent. Add one with event type webhook.test."
              : "The attempt is in the delivery record below, with the receiver's answer.",
        });
      }
      default:
        return botJson({ error: "action must be create, pause, resume, revoke or test." }, 400);
    }
  } catch {
    return botJson({ error: "The webhook change could not be applied." }, 503);
  }
}
