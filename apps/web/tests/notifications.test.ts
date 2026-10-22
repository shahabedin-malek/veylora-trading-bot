import assert from "node:assert/strict";
import test from "node:test";
import {
  alertWindowStart,
  dispatchAlertNotification,
  flushQueuedNotifications,
  isWithinQuietHours,
  type DeliveryPatch,
  type DeliveryRow,
  type NewDelivery,
  type NotificationStore,
} from "@/lib/notifications/dispatch";
import { sendEmailNotification } from "@/lib/notifications/email";
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  notificationChannelViews,
  validateNotificationSettings,
} from "@/lib/notifications/settings";
import { sendTelegramNotification } from "@/lib/notifications/telegram";

/**
 * The phase-29 guarantees, proven without a database or a network:
 *
 *  - one notification per (rule, condition, cooldown window);
 *  - quiet hours queue rather than drop, and the queue drains after the window;
 *  - an unconfigured channel names its variable and does not stop the others;
 *  - a retryable failure is retried with bounded backoff and every attempt recorded;
 *  - a token never appears in an error.
 */

const ALL_CHANNELS = {
  ...DEFAULT_NOTIFICATION_SETTINGS,
  emailEnabled: true,
  telegramEnabled: true,
};

const ENV = {
  RESEND_API_KEY: "re_test_only_placeholder",
  ALERT_EMAIL_FROM: "alerts@example.com",
  ALERT_EMAIL_TO: "owner@example.com",
  TELEGRAM_BOT_TOKEN: "123456:test-only-telegram-token",
  TELEGRAM_CHAT_ID: "-1001234567890",
};

const ALERT = {
  id: "alert-1",
  userId: "user-1",
  symbol: "BTC-USD",
  condition: "PRICE_ABOVE" as const,
  threshold: "70000",
  cooldownMinutes: 60,
};

class MemoryStore implements NotificationStore {
  rows: (NewDelivery & { id: string })[] = [];

  async findDelivery(dedupeKey: string) {
    const row = this.rows.find((entry) => entry.dedupeKey === dedupeKey);
    return row ? { id: row.id } : null;
  }

  async createDelivery(input: NewDelivery) {
    const row = { ...input, id: `delivery-${this.rows.length + 1}` };
    this.rows.push(row);
    return { id: row.id };
  }

  async listQueued(limit: number) {
    return this.rows.filter((row) => row.status === "QUEUED").slice(0, limit) as DeliveryRow[];
  }

  async claimQueued(id: string) {
    const row = this.rows.find((entry) => entry.id === id && entry.status === "QUEUED");
    if (!row) return false;
    row.status = "SENDING";
    return true;
  }

  async updateDelivery(id: string, patch: DeliveryPatch) {
    const row = this.rows.find((entry) => entry.id === id);
    if (!row) throw new Error(`No delivery ${id}`);
    Object.assign(row, patch);
  }
}

function okFetch(calls: string[] = []): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("resend.com")) {
      return new Response(JSON.stringify({ id: "email-msg-1" }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }), { status: 200 });
  }) as typeof fetch;
}

function statusFetch(status: number, failures: number): { fetchImpl: typeof fetch; calls: () => number } {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    if (calls <= failures) return new Response(JSON.stringify({ message: "upstream unavailable" }), { status });
    return new Response(JSON.stringify({ id: "email-msg-after-retry" }), { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, calls: () => calls };
}

const noSleep = async () => {};

test("a crossing notifies every enabled channel once and a second dispatch in the same window is a duplicate", async () => {
  const store = new MemoryStore();
  const deps = {
    settings: ALL_CHANNELS,
    store,
    env: ENV,
    fetchImpl: okFetch(),
    sleep: noSleep,
    now: new Date("2026-10-19T10:05:00.000Z"),
  };

  const first = await dispatchAlertNotification(
    { alert: ALERT, observedValue: "70150.25", triggeredAt: new Date("2026-10-19T10:05:00.000Z") },
    deps,
  );
  assert.equal(first.outcome, "SENT");
  assert.equal(first.sent, 3);
  assert.deepEqual(store.rows.map((row) => row.channel).sort(), ["EMAIL", "IN_APP", "TELEGRAM"]);
  assert.equal(store.rows.every((row) => row.status === "SENT"), true);
  assert.equal(store.rows.find((row) => row.channel === "EMAIL")?.target, "o***@example.com");
  assert.equal(store.rows.find((row) => row.channel === "TELEGRAM")?.target, "chat ***7890");

  const duplicate = await dispatchAlertNotification(
    { alert: ALERT, observedValue: "70151", triggeredAt: new Date("2026-10-19T10:40:00.000Z") },
    { ...deps, now: new Date("2026-10-19T10:40:00.000Z") },
  );
  assert.equal(duplicate.outcome, "DUPLICATE");
  assert.equal(store.rows.length, 3, "a duplicate crossing must not write or send anything");

  // A later cooldown window is a new notification, not a duplicate.
  const later = await dispatchAlertNotification(
    { alert: ALERT, observedValue: "70500", triggeredAt: new Date("2026-10-19T11:10:00.000Z") },
    { ...deps, now: new Date("2026-10-19T11:10:00.000Z") },
  );
  assert.equal(later.outcome, "SENT");
  assert.equal(store.rows.length, 6);
  assert.notEqual(
    alertWindowStart(new Date("2026-10-19T10:05:00.000Z"), 60).toISOString(),
    alertWindowStart(new Date("2026-10-19T11:10:00.000Z"), 60).toISOString(),
  );
});

test("quiet hours queue every channel and the queue drains once the window closes", async () => {
  const store = new MemoryStore();
  let fetches = 0;
  const fetchImpl = (async (input: RequestInfo | URL) => {
    fetches += 1;
    return String(input).includes("resend.com")
      ? new Response(JSON.stringify({ id: "sent-after-quiet" }), { status: 200 })
      : new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), { status: 200 });
  }) as typeof fetch;
  const settings = {
    ...ALL_CHANNELS,
    quietHoursEnabled: true,
    quietHoursStart: "22:00",
    quietHoursEnd: "07:00",
  };

  const queued = await dispatchAlertNotification(
    { alert: ALERT, observedValue: "70001", triggeredAt: new Date("2026-10-19T23:00:00.000Z") },
    { settings, store, env: ENV, fetchImpl, sleep: noSleep, now: new Date("2026-10-19T23:00:00.000Z") },
  );
  assert.equal(queued.outcome, "QUEUED");
  assert.equal(queued.queued, 3);
  assert.equal(store.rows.every((row) => row.status === "QUEUED"), true);
  assert.equal(fetches, 0, "nothing may be sent during quiet hours");

  const during = await flushQueuedNotifications({
    settings,
    store,
    env: ENV,
    fetchImpl,
    sleep: noSleep,
    now: new Date("2026-10-19T23:30:00.000Z"),
  });
  assert.equal(during.quietHours, true);
  assert.equal(during.delivered, 0);

  const after = await flushQueuedNotifications({
    settings,
    store,
    env: ENV,
    fetchImpl,
    sleep: noSleep,
    now: new Date("2026-10-20T07:05:00.000Z"),
  });
  assert.equal(after.quietHours, false);
  assert.equal(after.delivered, 3);
  assert.equal(store.rows.every((row) => row.status === "SENT"), true);
  assert.equal(store.rows.find((row) => row.channel === "EMAIL")?.providerMessageId, "sent-after-quiet");
});

test("an enabled Telegram channel with no credentials is skipped by name and the other channels still send", async () => {
  const store = new MemoryStore();
  const env = {
    RESEND_API_KEY: ENV.RESEND_API_KEY,
    ALERT_EMAIL_FROM: ENV.ALERT_EMAIL_FROM,
    ALERT_EMAIL_TO: ENV.ALERT_EMAIL_TO,
  };
  const summary = await dispatchAlertNotification(
    { alert: ALERT, observedValue: "70200", triggeredAt: new Date("2026-10-19T12:00:00.000Z") },
    { settings: ALL_CHANNELS, store, env, fetchImpl: okFetch(), sleep: noSleep, now: new Date("2026-10-19T12:00:00.000Z") },
  );

  const telegram = summary.channels.find((channel) => channel.channel === "TELEGRAM");
  assert.equal(telegram?.status, "SKIPPED");
  assert.match(telegram?.error ?? "", /TELEGRAM_BOT_TOKEN/);
  assert.match(telegram?.error ?? "", /TELEGRAM_CHAT_ID/);
  assert.equal(summary.sent, 2, "in-app and email must still deliver");
  const email = store.rows.find((row) => row.channel === "EMAIL");
  assert.equal(email?.status, "SENT");

  const view = notificationChannelViews(ALL_CHANNELS, env).find((channel) => channel.id === "TELEGRAM");
  assert.equal(view?.state, "NOT_CONFIGURED");
  assert.deepEqual(view?.missingVariables, ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"]);
});

test("a retryable delivery failure retries with bounded backoff and records every attempt", async () => {
  const store = new MemoryStore();
  const delays: number[] = [];
  const { fetchImpl, calls } = statusFetch(500, 2);
  const settings = { ...DEFAULT_NOTIFICATION_SETTINGS, inAppEnabled: false, emailEnabled: true };

  const summary = await dispatchAlertNotification(
    { alert: ALERT, observedValue: "70300", triggeredAt: new Date("2026-10-19T13:00:00.000Z") },
    {
      settings,
      store,
      env: ENV,
      fetchImpl,
      sleep: async (ms: number) => { delays.push(ms); },
      now: new Date("2026-10-19T13:00:00.000Z"),
    },
  );

  assert.equal(summary.outcome, "SENT");
  assert.equal(summary.sent, 1);
  assert.equal(calls(), 3);
  assert.deepEqual(delays, [250, 1_000]);
  assert.deepEqual(store.rows.map((row) => [row.attempt, row.status]), [[1, "FAILED"], [2, "FAILED"], [3, "SENT"]]);
  assert.equal(store.rows[0]?.error, "upstream unavailable");
  assert.equal(store.rows.at(-1)?.providerMessageId, "email-msg-after-retry");
});

test("a failure that outlasts the retries is reported with the provider's own answer", async () => {
  const store = new MemoryStore();
  const settings = { ...DEFAULT_NOTIFICATION_SETTINGS, inAppEnabled: false, emailEnabled: true };
  const summary = await dispatchAlertNotification(
    { alert: ALERT, observedValue: "70400", triggeredAt: new Date("2026-10-19T14:00:00.000Z") },
    {
      settings,
      store,
      env: ENV,
      fetchImpl: statusFetch(500, 99).fetchImpl,
      sleep: noSleep,
      now: new Date("2026-10-19T14:00:00.000Z"),
    },
  );

  assert.equal(summary.outcome, "FAILED");
  assert.equal(summary.failed, 1);
  assert.equal(store.rows.length, 3);
  assert.equal(store.rows.every((row) => row.status === "FAILED"), true);
  assert.equal(store.rows.at(-1)?.error, "upstream unavailable");
});

test("quiet hours wrap midnight and a disabled window is never quiet", () => {
  const settings = { ...DEFAULT_NOTIFICATION_SETTINGS, quietHoursEnabled: true, quietHoursStart: "22:00", quietHoursEnd: "07:00" };
  assert.equal(isWithinQuietHours(settings, new Date("2026-10-19T23:00:00.000Z")), true);
  assert.equal(isWithinQuietHours(settings, new Date("2026-10-19T06:59:00.000Z")), true);
  assert.equal(isWithinQuietHours(settings, new Date("2026-10-19T07:00:00.000Z")), false);
  assert.equal(isWithinQuietHours(settings, new Date("2026-10-19T12:00:00.000Z")), false);
  assert.equal(isWithinQuietHours({ ...settings, quietHoursEnabled: false }, new Date("2026-10-19T23:00:00.000Z")), false);
});

test("channel settings accept only booleans, clock times and a bounded whole cooldown", () => {
  assert.equal(validateNotificationSettings(DEFAULT_NOTIFICATION_SETTINGS).valid, true);
  assert.equal(validateNotificationSettings({ ...DEFAULT_NOTIFICATION_SETTINGS, emailEnabled: "yes" }).valid, false);
  assert.equal(validateNotificationSettings({ ...DEFAULT_NOTIFICATION_SETTINGS, quietHoursStart: "25:00" }).valid, false);
  assert.equal(validateNotificationSettings({ ...DEFAULT_NOTIFICATION_SETTINGS, defaultCooldownMinutes: 0 }).valid, false);
  assert.equal(validateNotificationSettings({ ...DEFAULT_NOTIFICATION_SETTINGS, defaultCooldownMinutes: 10_081 }).valid, false);
  assert.equal(validateNotificationSettings({ ...DEFAULT_NOTIFICATION_SETTINGS, webhookUrl: "x" }).valid, false);
});

test("a provider error never carries the Telegram token", async () => {
  const token = "987654:secret-which-must-not-leak";
  const fetchImpl = (async () => {
    throw new Error(`connect failed for https://api.telegram.org/bot${token}/sendMessage`);
  }) as typeof fetch;
  const result = await sendTelegramNotification(
    { subject: "BTC-USD", text: "test" },
    { env: { TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: "-1001" }, fetchImpl },
  );
  assert.equal(result.ok, false);
  assert.equal((result as { error: string }).error.includes(token), false);
  assert.match((result as { error: string }).error, /\[redacted\]/);
});

test("email configuration names the variable that is missing and never sends without all three", async () => {
  const result = await sendEmailNotification(
    { subject: "BTC-USD", text: "test" },
    { env: { RESEND_API_KEY: "re_test" } },
  );
  assert.equal(result.ok, false);
  assert.match((result as { error: string }).error, /ALERT_EMAIL_FROM/);
  assert.match((result as { error: string }).error, /ALERT_EMAIL_TO/);
  assert.equal((result as { retryable: boolean }).retryable, false);
});
