import { prisma } from "@/lib/db";
import {
  isStrategyActivationIntent,
  type StrategyActivationIntent,
  type StrategyRunState,
} from "@/lib/bot-builder/state-machine";
import { TERMINAL_ORDER_STATUSES } from "@/lib/orders/state-machine";
import { getRiskPolicySettings } from "@/lib/risk-controls/settings";
import { dueGraceMs, runnerStore } from "@/lib/runner/claim";
import { orderVenueSummary } from "@/lib/venues/registry";
import { canStartBotStrategy, listStartableStrategies, readBotStrategyLabel } from "@/lib/bot-builder/repository";
import { parseBotStrategyId } from "@/lib/bot-builder/publish";
import {
  DEFAULT_SMART_STRATEGY_ID,
  findSmartStrategy,
  STRATEGY_JOB_ID,
  STRATEGY_JOB_INTERVAL_MINUTES,
  STRATEGY_JOB_LABEL,
  type SmartStrategy,
} from "./schedule";
import {
  describeStrategyActivation,
  formatTimestamp,
  isoTimestamp,
  planActivationChange,
  STATE_LABELS,
  type ActivationSnapshot,
  type RunnerReadiness,
  type StrategyActivationView,
  type VenueReadiness,
} from "./state";
import { auditCreate } from "@/lib/audit/record";

export * from "./state";

/**
 * Smart-trading activation: the owner's one switch, persisted, audited and observed by the
 * runner.
 *
 * The state model it renders lives in `./state.ts` and is re-exported above, so callers see
 * one module while the rules stay testable without a database. What is here is the reading
 * and the two writes: each is one row per account plus one audit event, and neither can
 * refuse for an incomplete configuration — that is a state the panel names, not a gate.
 */


// ---------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------

type ActivationRow = {
  id: string;
  userId: string;
  status: string;
  strategyId: string | null;
  startedAt: Date | null;
  stoppedAt: Date | null;
  lastChangeReason: string | null;
  lastChangedByUserId: string | null;
  lastChangedAt: Date | null;
  lastEvaluatedAt: Date | null;
  lastOutcome: string | null;
  lastReasonCode: string | null;
  lastReasonMessage: string | null;
  runCount: number;
};

function snapshot(row: ActivationRow): ActivationSnapshot {
  return {
    id: row.id,
    status: row.status,
    strategyId: row.strategyId,
    startedAt: row.startedAt?.getTime() ?? null,
    stoppedAt: row.stoppedAt?.getTime() ?? null,
    lastChangeReason: row.lastChangeReason,
    lastChangedAt: row.lastChangedAt?.getTime() ?? null,
    lastChangedBy: row.lastChangedByUserId,
    lastEvaluatedAt: row.lastEvaluatedAt?.getTime() ?? null,
    lastOutcome: row.lastOutcome,
    lastReasonCode: row.lastReasonCode,
    lastReasonMessage: row.lastReasonMessage,
    runCount: row.runCount,
  };
}

const ACTIVATION_SELECT = {
  id: true,
  userId: true,
  status: true,
  strategyId: true,
  startedAt: true,
  stoppedAt: true,
  lastChangeReason: true,
  lastChangedByUserId: true,
  lastChangedAt: true,
  lastEvaluatedAt: true,
  lastOutcome: true,
  lastReasonCode: true,
  lastReasonMessage: true,
  runCount: true,
} as const;

/**
 * How the strategy job looks from here.
 *
 * "Scheduled" means the runner has a heartbeat for the job and it has not gone stale. A
 * job that has never run since it was registered is scheduled: activation registers it and
 * its next due time is now, so the next invocation is the first pass. What is *not*
 * scheduled is a job with no row, or one whose last run is more than twice its interval
 * old — the phase-05 runner's own definition of a schedule that stopped delivering.
 */
async function readRunnerReadiness(now: number): Promise<RunnerReadiness> {
  const cadence = `${STRATEGY_JOB_INTERVAL_MINUTES} minutes`;
  let states;
  try {
    states = await runnerStore().listJobs([STRATEGY_JOB_ID]);
  } catch {
    return {
      jobId: STRATEGY_JOB_ID,
      label: STRATEGY_JOB_LABEL,
      scheduled: false,
      cadence,
      nextDueAt: null,
      lastFinishedAt: null,
      detail:
        "The runner's heartbeat could not be read, so the next pass cannot be confirmed. The activation is saved and will run once the heartbeat is readable.",
    };
  }
  const state = states[0];
  if (!state) {
    return {
      jobId: STRATEGY_JOB_ID,
      label: STRATEGY_JOB_LABEL,
      scheduled: false,
      cadence,
      nextDueAt: null,
      lastFinishedAt: null,
      detail:
        `The runner has not registered the ${STRATEGY_JOB_LABEL} job, so no pass is scheduled. ` +
        `Call /api/cron/${STRATEGY_JOB_ID} with CRON_SECRET, or let the host's schedule deliver it.`,
    };
  }
  const anchor = state.lastFinishedAt ?? state.lastStartedAt;
  const stale =
    anchor !== null && now - anchor > state.intervalMinutes * 60_000 * 2 + dueGraceMs(state.intervalMinutes);
  return {
    jobId: STRATEGY_JOB_ID,
    label: STRATEGY_JOB_LABEL,
    scheduled: !stale,
    cadence,
    nextDueAt: isoTimestamp(state.nextDueAt),
    lastFinishedAt: isoTimestamp(state.lastFinishedAt),
    detail: stale
      ? `The strategy job last ran at ${formatTimestamp(anchor)}, more than twice its ${cadence} interval ago, so the schedule may have stopped delivering invocations.`
      : state.lastFinishedAt
        ? `The last pass finished at ${formatTimestamp(state.lastFinishedAt)}; the next is due at ${formatTimestamp(state.nextDueAt)}.`
        : `The strategy job is registered and due now; the next runner invocation is its first pass.`,
  };
}

function describeVenue(input: {
  credentials: readonly { venue: string; readOnly: boolean }[];
  routing: Awaited<ReturnType<typeof orderVenueSummary>> | null;
}): VenueReadiness {
  const connected = input.credentials.length;
  const placeable = input.credentials.filter((credential) => !credential.readOnly).length;
  const routing = input.routing;
  const mode = routing?.environment ?? "paper";
  const label = routing?.label ?? null;
  const detail =
    connected === 0
      ? "No exchange account is connected for this account."
      : placeable === 0
        ? "The connected keys are stored as read-only, so they cannot place an order."
        : `${placeable} trade-capable key(s) connected${label ? `; orders would go to ${label}` : ""}.`;
  return {
    connectedCount: connected,
    placeableCount: placeable,
    label,
    routing: mode,
    liveExecutionEnabled: routing?.liveExecutionEnabled === true,
    detail,
  };
}

async function readContext(userId: string, rowOverride?: ActivationRow | null) {
  const now = Date.now();
  const row =
    rowOverride === undefined
      ? ((await prisma.strategyActivation.findUnique({ where: { userId }, select: ACTIVATION_SELECT })) as ActivationRow | null)
      : rowOverride;

  const [credentials, risk, routing, runner, openOrders, lastChangedByLabel] = await Promise.all([
    prisma.tradingVenueCredential
      .findMany({
        where: { userId, revokedAt: null },
        select: { venue: true, readOnly: true },
        orderBy: { createdAt: "desc" },
      })
      .catch(() => []),
    getRiskPolicySettings().catch(() => null),
    orderVenueSummary().catch(() => null),
    readRunnerReadiness(now),
    prisma.tradeOrder
      .count({ where: { userId, status: { notIn: [...TERMINAL_ORDER_STATUSES] } } })
      .catch(() => null),
    row?.lastChangedByUserId
      ? prisma.walletIdentity
          .findFirst({
            where: { userId: row.lastChangedByUserId, revokedAt: null },
            orderBy: { verifiedAt: "desc" },
            select: { addressDisplay: true },
          })
          .then((identity) => identity?.addressDisplay ?? row.lastChangedByUserId)
          .catch(() => row.lastChangedByUserId)
      : Promise.resolve(null),
  ]);

  // The control offers the built-ins plus this account's published bots. Reading the bots
  // on a stopped account is deliberate: choosing a bot is how a stopped account starts one.
  const bots = await listStartableStrategies(userId).catch(() => []);
  const builtIn = findSmartStrategy(row?.strategyId ?? null);
  const activeBotId = parseBotStrategyId(row?.strategyId ?? null);
  const activeBotLabel = !builtIn && activeBotId
    ? await readBotStrategyLabel(userId, row?.strategyId ?? null).catch(() => null)
    : null;
  const activeBot = activeBotLabel
    ? {
        id: row!.strategyId!,
        label: activeBotLabel,
        detail: activeBotLabel.includes("(deleted)")
          ? "This bot was deleted, so the runner records that there is nothing to evaluate. Choose another strategy to start."
          : "This account's selected published bot.",
      }
    : null;
  const strategyCatalog = activeBot && !bots.some((bot) => bot.id === activeBot.id) ? [activeBot, ...bots] : bots;

  return {
    now,
    row,
    strategy: builtIn ?? activeBot,
    strategyCatalog,
    venue: describeVenue({ credentials, routing }),
    riskKillSwitchActive: risk?.killSwitchActive === true,
    runner,
    openOrderCount: openOrders,
    lastChangedByLabel,
  };
}

/** The current state of this account's activation. Never throws for a missing row. */
export async function getStrategyActivationView(userId: string): Promise<StrategyActivationView> {
  const context = await readContext(userId);
  return describeStrategyActivation({
    row: context.row ? snapshot(context.row) : null,
    now: context.now,
    strategy: context.strategy,
    strategyCatalog: context.strategyCatalog,
    venue: context.venue,
    riskKillSwitchActive: context.riskKillSwitchActive,
    runner: context.runner,
    openOrderCount: context.openOrderCount,
    lastChangedByLabel: context.lastChangedByLabel,
  });
}

// ---------------------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------------------

export type ActivationMutation = {
  view: StrategyActivationView;
  changed: boolean;
  message: string;
  auditAction: "STRATEGY_TRADING_STARTED" | "STRATEGY_TRADING_STOPPED" | null;
};

/**
 * Whether this account may name this strategy in a start.
 *
 * Built-ins are always startable; `bot:<id>` is startable only when the bot is this
 * account's, published and not deleted. The route asks this before it writes so an id from
 * another account is a plain refusal rather than a start with no strategy.
 */
export async function isStartableStrategy(userId: string, strategyId: string): Promise<boolean> {
  if (findSmartStrategy(strategyId)) return true;
  return canStartBotStrategy(userId, strategyId).catch(() => false);
}

async function resolveStartStrategy(userId: string, strategyId: string | null | undefined): Promise<SmartStrategy | null> {
  if (strategyId === null) return null;
  if (strategyId === undefined) return findSmartStrategy(DEFAULT_SMART_STRATEGY_ID);
  const builtIn = findSmartStrategy(strategyId);
  if (builtIn) return builtIn;
  const bots = await listStartableStrategies(userId).catch(() => []);
  const bot = bots.find((candidate) => candidate.id === strategyId);
  if (bot) return bot;
  throw new UnstartableStrategyError(strategyId);
}

export class UnstartableStrategyError extends Error {
  constructor(strategyId: string) {
    super(`"${strategyId}" is not a strategy this account can start. Choose a built-in strategy or one of your published bots.`);
    this.name = "UnstartableStrategyError";
  }
}

/**
 * Start smart trading for this account, or answer that it is already running.
 *
 * The write is one upsert plus one audit row in the same transaction. A second press while
 * RUNNING changes nothing and writes nothing, which is what makes the control idempotent;
 * the row is unique per account, so any number of presses leave exactly one activation.
 * There is no validation that could refuse the start: an incomplete configuration is a
 * state the panel names (see the blockers), not a reason to make the button dead.
 */
export async function startStrategyActivation(input: {
  userId: string;
  strategyId?: string | null;
  reason?: string;
  now?: Date;
}): Promise<ActivationMutation> {
  const now = input.now ?? new Date();
  const strategy = await resolveStartStrategy(input.userId, input.strategyId);
  const strategyId = strategy?.id ?? null;
  const startedBotId = parseBotStrategyId(strategyId);
  const reason = input.reason ?? "OWNER_STARTED";

  const before = (await prisma.strategyActivation.findUnique({
    where: { userId: input.userId },
    select: ACTIVATION_SELECT,
  })) as ActivationRow | null;

  const plan = planActivationChange({
    action: "start",
    currentStatus: before?.status ?? null,
    strategyLabel: strategy?.label ?? findSmartStrategy(before?.strategyId ?? null)?.label ?? null,
    // A start that names a different strategy while RUNNING is a strategy change, not a
    // no-op: without these two ids the new bot would be reported as "already running" and
    // the activation would keep evaluating the old rules.
    currentStrategyId: before?.strategyId ?? null,
    nextStrategyId: strategyId,
  });
  if (!plan.write) {
    return {
      view: await getActivationViewFrom(input.userId, before, now.getTime()),
      changed: false,
      message: plan.message,
      auditAction: null,
    };
  }

  const saved = (await prisma.$transaction(async (transaction) => {
    const row = await transaction.strategyActivation.upsert({
      where: { userId: input.userId },
      create: {
        userId: input.userId,
        status: "RUNNING",
        strategyId,
        startedAt: now,
        lastChangeReason: reason,
        lastChangedByUserId: input.userId,
        lastChangedAt: now,
      },
      update: {
        status: "RUNNING",
        strategyId,
        startedAt: now,
        stoppedAt: null,
        lastChangeReason: reason,
        lastChangedByUserId: input.userId,
        lastChangedAt: now,
        // A new start clears the previous pass's verdict: the panel should say "waiting for
        // the first pass", not repeat a reason that belonged to the run the owner restarted.
        // The window claim is cleared with it, so the next invocation evaluates this
        // interval instead of skipping it because a previous run already had it.
        lastOutcome: null,
        lastReasonCode: null,
        lastReasonMessage: null,
        lastWindowStart: null,
      },
      select: ACTIVATION_SELECT,
    });
    await auditCreate(transaction, {
      data: {
        actorUserId: input.userId,
        action: "STRATEGY_TRADING_STARTED",
        objectType: "StrategyActivation",
        objectId: row.id,
        outcome: "SUCCESS",
        redactedJson: JSON.stringify({
          from: before?.status ?? null,
          to: "RUNNING",
          strategyId,
          reason,
          at: now.toISOString(),
          source: "trade-page",
        }),
      },
    });
    if (startedBotId) {
      await auditCreate(transaction, {
        data: {
          actorUserId: input.userId,
          action: "BOT_STARTED",
          objectType: "Bot",
          objectId: startedBotId,
          outcome: "SUCCESS",
          redactedJson: JSON.stringify({ activationId: row.id, at: now.toISOString(), source: "trade-page" }),
        },
      });
    }
    return row as ActivationRow;
  })) as ActivationRow;

  // Registering the job is what makes "next pass" a real time rather than a promise. It is
  // best-effort: if the heartbeat cannot be written, the view reports the job as not
  // scheduled and the activation stays saved.
  await runnerStore()
    .ensureJob({ jobId: STRATEGY_JOB_ID, intervalMinutes: STRATEGY_JOB_INTERVAL_MINUTES, now: now.getTime() })
    .catch(() => null);

  return {
    view: await getActivationViewFrom(input.userId, saved, now.getTime()),
    changed: true,
    message: `Smart trading started for this account${strategy ? ` with ${strategy.label}` : ""}; the runner will pick it up on its next pass.`,
    auditAction: "STRATEGY_TRADING_STARTED",
  };
}

/**
 * Stop smart trading, or answer that it is already stopped.
 *
 * Stopping writes the owner's intent and nothing else. It does not touch an order: an
 * order already at a venue keeps its own lifecycle and the reconciliation job still asks
 * the venue about it. That is the requirement — a stop is immediate, idempotent and never
 * abandons a position.
 */
export async function stopStrategyActivation(input: {
  userId: string;
  activationId?: string;
  reason?: string;
  now?: Date;
}): Promise<ActivationMutation> {
  const now = input.now ?? new Date();
  const reason = input.reason ?? "OWNER_STOPPED";

  const before = (await prisma.strategyActivation.findUnique({
    where: { userId: input.userId },
    select: ACTIVATION_SELECT,
  })) as ActivationRow | null;

  if (input.activationId && before?.id !== input.activationId) {
    throw new ActivationNotFoundError();
  }

  const plan = planActivationChange({ action: "stop", currentStatus: before?.status ?? null });
  if (!plan.write) {
    return {
      view: await getActivationViewFrom(input.userId, before, now.getTime()),
      changed: false,
      message: plan.message,
      auditAction: null,
    };
  }

  const saved = (await prisma.$transaction(async (transaction) => {
    const row = await transaction.strategyActivation.update({
      where: { userId: input.userId },
      data: {
        status: "STOPPED",
        stoppedAt: now,
        lastChangeReason: reason,
        lastChangedByUserId: input.userId,
        lastChangedAt: now,
      },
      select: ACTIVATION_SELECT,
    });
    await auditCreate(transaction, {
      data: {
        actorUserId: input.userId,
        action: "STRATEGY_TRADING_STOPPED",
        objectType: "StrategyActivation",
        objectId: row.id,
        outcome: "SUCCESS",
        redactedJson: JSON.stringify({
          from: "RUNNING",
          to: "STOPPED",
          strategyId: row.strategyId,
          reason,
          at: now.toISOString(),
          lastPass: {
            at: row.lastEvaluatedAt?.toISOString() ?? null,
            outcome: row.lastOutcome,
            code: row.lastReasonCode,
          },
          source: "trade-page",
        }),
      },
    });
    const stoppedBotId = parseBotStrategyId(row.strategyId);
    if (stoppedBotId) {
      await auditCreate(transaction, {
        data: {
          actorUserId: input.userId,
          action: "BOT_STOPPED",
          objectType: "Bot",
          objectId: stoppedBotId,
          outcome: "SUCCESS",
          redactedJson: JSON.stringify({ activationId: row.id, at: now.toISOString(), source: "trade-page" }),
        },
      });
    }
    return row as ActivationRow;
  })) as ActivationRow;

  return {
    view: await getActivationViewFrom(input.userId, saved, now.getTime()),
    changed: true,
    message:
      "Smart trading stopped. Orders already placed keep their own lifecycle and are reconciled; none were cancelled or abandoned.",
    auditAction: "STRATEGY_TRADING_STOPPED",
  };
}

export class ActivationNotFoundError extends Error {
  constructor() {
    super("This activation belongs to another account, so it cannot be changed here.");
    this.name = "ActivationNotFoundError";
  }
}

async function getActivationViewFrom(userId: string, row: ActivationRow | null, now: number) {
  const context = await readContext(userId, row);
  return describeStrategyActivation({    row: row ? snapshot(row) : null,
    now,
    strategy: context.strategy,
    strategyCatalog: context.strategyCatalog,
    venue: context.venue,
    riskKillSwitchActive: context.riskKillSwitchActive,
    runner: context.runner,
    openOrderCount: context.openOrderCount,
    lastChangedByLabel: context.lastChangedByLabel,
  });
}

// ---------------------------------------------------------------------------------------
// The admin console's per-account view
// ---------------------------------------------------------------------------------------

export type ActivationDirectoryEntry = {
  userId: string;
  state: StrategyRunState;
  stateLabel: StrategyActivationView["stateLabel"];
  intent: StrategyActivationIntent | null;
  headline: string;
  reason: { code: string; message: string } | null;
  strategyLabel: string | null;
  startedAt: string | null;
  stoppedAt: string | null;
  lastChangedAt: string | null;
  lastChangedBy: string | null;
  lastChangeReason: string | null;
  lastEvaluatedAt: string | null;
  lastOutcome: string | null;
  runCount: number;
};

/**
 * Every visible account's activation, including the accounts that have none.
 *
 * The admin console reads the state the runner recorded rather than recomputing it: that is
 * the same verdict the owner's panel shows, and it keeps the directory cheap on a page that
 * already lists the whole directory. An account with no row is shown as NOT STARTED rather
 * than omitted, because "this account is not trading" is the answer to the question.
 */
export async function getActivationDirectory(userIds: readonly string[]): Promise<ActivationDirectoryEntry[]> {
  if (userIds.length === 0) return [];
  const rows = (await prisma.strategyActivation.findMany({
    where: { userId: { in: [...userIds] } },
    select: ACTIVATION_SELECT,
  })) as ActivationRow[];
  const byUser = new Map(rows.map((row) => [row.userId, row]));

  const changedByIds = [...new Set(rows.map((row) => row.lastChangedByUserId).filter((id): id is string => Boolean(id)))];
  const identities = changedByIds.length
    ? await prisma.walletIdentity
        .findMany({
          where: { userId: { in: changedByIds }, revokedAt: null },
          orderBy: { verifiedAt: "desc" },
          select: { userId: true, addressDisplay: true },
        })
        .catch(() => [])
    : [];
  const labels = new Map<string, string>();
  for (const identity of identities) {
    if (!labels.has(identity.userId)) labels.set(identity.userId, identity.addressDisplay);
  }

  return userIds.map((userId) => {
    const row = byUser.get(userId);
    const intent = row && isStrategyActivationIntent(row.status) ? row.status : null;
    const state: StrategyRunState = intent !== "RUNNING"
      ? "stopped"
      : row?.lastOutcome === "error"
        ? "error"
        : row?.lastOutcome === "idle"
          ? "idle"
          : "running";
    const reason =
      state === "stopped"
        ? row?.stoppedAt
          ? { code: "OWNER_STOPPED", message: `Stopped by owner at ${row.stoppedAt.toISOString()}.` }
          : { code: "NOT_STARTED", message: "Smart trading has not been started for this account." }
        : state === "error"
          ? { code: "LAST_PASS_FAILED", message: row?.lastReasonMessage ?? "The last pass failed." }
          : state === "idle"
            ? { code: row?.lastReasonCode ?? "NO_ENTRY_CONDITION", message: row?.lastReasonMessage ?? "The last pass was idle." }
            : null;
    return {
      userId,
      state,
      stateLabel: STATE_LABELS[state],
      intent,
      headline:
        state === "running"
          ? "Running"
          : state === "idle"
            ? "Idle"
            : state === "error"
              ? "Needs attention"
              : row
                ? "Stopped"
                : "Not started",
      reason,
      strategyLabel: findSmartStrategy(row?.strategyId ?? null)?.label ?? null,
      startedAt: row?.startedAt?.toISOString() ?? null,
      stoppedAt: row?.stoppedAt?.toISOString() ?? null,
      lastChangedAt: row?.lastChangedAt?.toISOString() ?? null,
      lastChangedBy: row?.lastChangedByUserId ? labels.get(row.lastChangedByUserId) ?? row.lastChangedByUserId : null,
      lastChangeReason: row?.lastChangeReason ?? null,
      lastEvaluatedAt: row?.lastEvaluatedAt?.toISOString() ?? null,
      lastOutcome: row?.lastOutcome ?? null,
      runCount: row?.runCount ?? 0,
    };
  });
}
