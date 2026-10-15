import assert from "node:assert/strict";
import test from "node:test";
import { claimAndAuditAlertTrigger } from "@/lib/alerts/evaluate";

test("concurrent alert retries create one event and one audit row", async () => {
  let status = "ACTIVE";
  const events: unknown[] = [];
  const audits: unknown[] = [];
  const transaction = {
    marketAlert: {
      updateMany: async ({ where, data }: { where: { status: string }; data: { status: string } }) => {
        if (status !== where.status) return { count: 0 };
        status = data.status;
        return { count: 1 };
      },
    },
    marketAlertEvent: { create: async ({ data }: { data: unknown }) => { events.push(data); } },
    auditEvent: { create: async ({ data }: { data: unknown }) => { audits.push(data); } },
  } as never;
  const alert = { id: "alert-1", userId: "user-1", symbol: "BTC-USD", condition: "PRICE_ABOVE", threshold: "100" };
  const observation = { value: "101", observedAt: new Date("2026-10-15T12:00:00.000Z") };
  const triggeredAt = new Date("2026-10-15T12:00:01.000Z");

  const first = await claimAndAuditAlertTrigger(transaction, alert, observation, triggeredAt);
  const retry = await claimAndAuditAlertTrigger(transaction, alert, observation, triggeredAt);

  assert.equal(first, true);
  assert.equal(retry, false);
  assert.equal(status, "TRIGGERED");
  assert.equal(events.length, 1);
  assert.equal(audits.length, 1);
  assert.deepEqual(events[0], {
    alertId: "alert-1",
    actorUserId: "user-1",
    observedValue: "101",
    sourceObservedAt: observation.observedAt,
    providerId: "coinbase-exchange",
    triggeredAt,
  });
  assert.equal((audits[0] as { action: string }).action, "MARKET_ALERT_TRIGGERED");
});