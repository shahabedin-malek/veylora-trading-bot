import assert from "node:assert/strict";
import test from "node:test";
import { claimAndAuditAlertTrigger } from "@/lib/alerts/evaluate";

/**
 * The claim is where phase 29's two repetition guards live: a fire requires the condition to
 * have been false (a crossing) and the previous fire to be older than the rule's cooldown.
 * Both are conditions on one atomic update, so two overlapping evaluators cannot both win.
 */
function transactionFixture(initial: { triggeredAt?: Date | null; conditionMet?: boolean } = {}) {
  const state = {
    status: "ACTIVE",
    conditionMet: initial.conditionMet ?? false,
    triggeredAt: initial.triggeredAt ?? null,
  };
  const events: Record<string, unknown>[] = [];
  const audits: Record<string, unknown>[] = [];
  const transaction = {
    marketAlert: {
      updateMany: async ({ where, data }: {
        where: { status: string; conditionMet: boolean; OR?: { triggeredAt: { lte: Date } }[] };
        data: { conditionMet: boolean; triggeredAt: Date };
      }) => {
        if (state.status !== where.status) return { count: 0 };
        if (where.conditionMet === false && state.conditionMet) return { count: 0 };
        const floor = where.OR?.[1]?.triggeredAt.lte;
        if (floor && state.triggeredAt && state.triggeredAt.getTime() > floor.getTime()) return { count: 0 };
        state.conditionMet = data.conditionMet;
        state.triggeredAt = data.triggeredAt;
        return { count: 1 };
      },
    },
    marketAlertEvent: { create: async ({ data }: { data: Record<string, unknown> }) => { events.push(data); } },
    auditEvent: {
      findFirst: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => { audits.push(data); },
    },
  } as never;
  return { state, events, audits, transaction };
}

const ALERT = {
  id: "alert-1",
  userId: "user-1",
  symbol: "BTC-USD",
  condition: "PRICE_ABOVE",
  threshold: "100",
  cooldownMinutes: 60,
  conditionMet: false,
  triggeredAt: null,
};

const OBSERVATION = { value: "101", observedAt: new Date("2026-10-15T12:00:00.000Z") };
const TRIGGERED_AT = new Date("2026-10-15T12:00:01.000Z");

test("concurrent alert retries create one event and one audit row", async () => {
  const fixture = transactionFixture();
  const first = await claimAndAuditAlertTrigger(fixture.transaction, ALERT, OBSERVATION, TRIGGERED_AT);
  const retry = await claimAndAuditAlertTrigger(fixture.transaction, ALERT, OBSERVATION, TRIGGERED_AT);

  assert.equal(first, true);
  assert.equal(retry, false);
  assert.equal(fixture.state.conditionMet, true);
  assert.equal(fixture.events.length, 1);
  assert.equal(fixture.audits.length, 1);
  assert.deepEqual(fixture.events[0], {
    alertId: "alert-1",
    actorUserId: "user-1",
    observedValue: "101",
    sourceObservedAt: OBSERVATION.observedAt,
    providerId: "coinbase-exchange",
    windowStart: new Date("2026-10-15T12:00:00.000Z"),
    triggeredAt: TRIGGERED_AT,
  });
  assert.equal((fixture.audits[0] as { action: string }).action, "MARKET_ALERT_TRIGGERED");
});

test("a re-crossing inside the cooldown is not a second fire, and the first one after it is", async () => {
  const fixture = transactionFixture({ conditionMet: false, triggeredAt: new Date("2026-10-15T12:00:00.000Z") });

  const insideCooldown = await claimAndAuditAlertTrigger(
    fixture.transaction,
    ALERT,
    OBSERVATION,
    new Date("2026-10-15T12:30:00.000Z"),
  );
  assert.equal(insideCooldown, false, "45 minutes after a fire is inside a 60-minute cooldown");
  assert.equal(fixture.events.length, 0);

  const afterCooldown = await claimAndAuditAlertTrigger(
    fixture.transaction,
    ALERT,
    OBSERVATION,
    new Date("2026-10-15T13:00:00.000Z"),
  );
  assert.equal(afterCooldown, true);
  assert.equal(fixture.events.length, 1);
  assert.equal(
    (fixture.events[0]?.windowStart as Date).toISOString(),
    new Date("2026-10-15T13:00:00.000Z").toISOString(),
    "the new fire belongs to its own cooldown window",
  );
});
