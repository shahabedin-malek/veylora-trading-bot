import {
  evaluateStrategyRunState,
  isStrategyActivationIntent,
  type StrategyActivationIntent,
  type StrategyRunState,
} from "@/lib/bot-builder/state-machine";
import { SMART_STRATEGIES, type SmartStrategy } from "./schedule";

/**
 * The pure half of smart-trading activation: what the panel shows, and whether a press
 * changes anything.
 *
 * It is separate from `activation.ts` for the same reason `risk-controls/policy.ts` is
 * separate from `risk-controls/settings.ts`: the state model is a rule that must be
 * testable without a database, and importing the persistence module would construct a
 * Prisma client and read four tables to answer a question that is arithmetic on facts the
 * caller already has. `activation.ts` re-exports everything here, so callers never need to
 * know which half a name lives in.
 */

/**
 * Why an activation is not running. Every non-running state the phase names has a code
 * here, plus the two the panel needs to explain itself: `NOT_STARTED` (no row yet) and
 * `LAST_PASS_FAILED` (the error state).
 */
export const ACTIVATION_REASON_CODES = [
  "NOT_STARTED",
  "OWNER_STOPPED",
  "NO_STRATEGY_SELECTED",
  "NO_VENUE_CONNECTED",
  "NO_PLACEABLE_VENUE",
  "RISK_LIMIT_REACHED",
  "RUNNER_NOT_SCHEDULED",
  "LAST_PASS_FAILED",
] as const;

export type ActivationReasonCode = (typeof ACTIVATION_REASON_CODES)[number];

export type ActivationBlocker = {
  code: ActivationReasonCode;
  message: string;
  /** What to change, and where — never a dead end. */
  action: { label: string; href: string };
};

export type ActivationSnapshot = {
  id: string;
  status: string;
  strategyId: string | null;
  startedAt: number | null;
  stoppedAt: number | null;
  lastChangeReason: string | null;
  lastChangedAt: number | null;
  lastChangedBy: string | null;
  lastEvaluatedAt: number | null;
  lastOutcome: string | null;
  lastReasonCode: string | null;
  lastReasonMessage: string | null;
  runCount: number;
};

export type VenueReadiness = {
  /** Unrevoked keys on the account, of any scope. */
  connectedCount: number;
  /** Of those, the ones that can place an order. A read-only key cannot. */
  placeableCount: number;
  label: string | null;
  routing: "paper" | "testnet" | "live";
  liveExecutionEnabled: boolean;
  detail: string;
};

export type RunnerReadiness = {
  jobId: string;
  label: string;
  scheduled: boolean;
  cadence: string;
  nextDueAt: string | null;
  lastFinishedAt: string | null;
  detail: string;
};

export type StrategyActivationView = {
  id: string | null;
  state: StrategyRunState;
  stateLabel: "RUNNING" | "IDLE" | "STOPPED" | "ERROR";
  intent: StrategyActivationIntent | null;
  headline: string;
  detail: string;
  reason: { code: ActivationReasonCode; message: string } | null;
  blockers: ActivationBlocker[];
  strategy: SmartStrategy | null;
  strategyCatalog: SmartStrategy[];
  startedAt: string | null;
  stoppedAt: string | null;
  elapsedMs: number | null;
  lastChange: { reason: string | null; at: string | null; by: string | null };
  lastPass: {
    at: string | null;
    outcome: string | null;
    code: string | null;
    message: string | null;
    runCount: number;
  };
  runner: RunnerReadiness;
  placement: {
    mode: "paper" | "testnet" | "live";
    label: "PAPER PLACEMENT" | "TESTNET PLACEMENT" | "LIVE PLACEMENT";
    liveExecutionEnabled: boolean;
    detail: string;
  };
  openOrderCount: number | null;
  actions: {
    start: { label: string; detail: string };
    stop: { label: string; detail: string };
  };
};

export type DescribeActivationInput = {
  row: ActivationSnapshot | null;
  now: number;
  strategy: SmartStrategy | null;
  /** The built-ins plus this account's published bots, in the order the control offers them. */
  strategyCatalog?: SmartStrategy[];
  venue: VenueReadiness;
  riskKillSwitchActive: boolean;
  runner: RunnerReadiness;
  openOrderCount: number | null;
  lastChangedByLabel: string | null;
};

export const STATE_LABELS: Record<StrategyRunState, StrategyActivationView["stateLabel"]> = {
  running: "RUNNING",
  idle: "IDLE",
  stopped: "STOPPED",
  error: "ERROR",
};

export function isoTimestamp(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

export function formatTimestamp(value: number | null): string {
  return value === null ? "not yet" : new Date(value).toISOString();
}

function normalizedLastOutcome(value: string | null): "running" | "idle" | "error" | null {
  return value === "running" || value === "idle" || value === "error" ? value : null;
}

/**
 * What the panel shows, from what the build knows — no writes, no clock of its own.
 *
 * The order of the checks is the order of the owner's fixes: the strategy first (there is
 * nothing to run without one), then a place to send orders, then the risk policy, then the
 * schedule. `stopped` outranks everything because it is the owner's instruction, and an
 * error is shown only when no configuration fact explains it.
 */
export function describeStrategyActivation(input: DescribeActivationInput): StrategyActivationView {
  const { row, now, strategy, venue, runner } = input;
  const intent = row && isStrategyActivationIntent(row.status) ? row.status : null;

  // Blockers describe why a *running* activation cannot place; they are not a pre-flight
  // checklist for a stopped one. In particular, a not-started row has no strategy id yet
  // because start selects the default, so reporting "no strategy selected" before the
  // owner has pressed anything would be untrue. Starting is what reveals a gap — and the
  // start always succeeds, so the reveal is the panel, not a refusal.
  const blockers: ActivationBlocker[] = [];
  if (intent === "RUNNING") {
    if (!strategy) {
      blockers.push({
        code: "NO_STRATEGY_SELECTED",
        message:
          "No strategy is selected, so the runner has no entry or exit rule to evaluate. Choose one in the start control.",
        action: { label: "Choose a strategy", href: "/trade" },
      });
    }
    if (venue.placeableCount === 0) {
      blockers.push(
        venue.connectedCount === 0
          ? {
              code: "NO_VENUE_CONNECTED",
              message:
                "No exchange account is connected, so a pass would have nowhere to place an order and the order path would refuse it.",
              action: { label: "Connect a venue key", href: "/admin/access" },
            }
          : {
              code: "NO_PLACEABLE_VENUE",
              message:
                "The only connected key is stored as read-only, so a pass could read balances but could not place an order.",
              action: { label: "Connect a trading key", href: "/admin/access" },
            },
      );
    }
    if (input.riskKillSwitchActive) {
      blockers.push({
        code: "RISK_LIMIT_REACHED",
        message:
          "The kill switch is engaged in the risk policy, so every order intent is refused. The activation stays saved and resumes when it is released.",
        action: { label: "Open risk controls", href: "/admin/risk" },
      });
    }
    if (!runner.scheduled) {
      blockers.push({
        code: "RUNNER_NOT_SCHEDULED",
        message: runner.detail,
        action: { label: "Runner heartbeat", href: "/admin/data" },
      });
    }
  }

  const lastOutcome = normalizedLastOutcome(row?.lastOutcome ?? null);
  const state = evaluateStrategyRunState({ intent, blockerCount: blockers.length, lastOutcome });

  let reason: StrategyActivationView["reason"] = null;
  if (state === "stopped") {
    reason = row?.stoppedAt
      ? {
          code: "OWNER_STOPPED",
          message: `Stopped by owner at ${formatTimestamp(row.stoppedAt)}${input.lastChangedByLabel ? ` (${input.lastChangedByLabel})` : ""}. Nothing is being evaluated.`,
        }
      : {
          code: "NOT_STARTED",
          message: "Smart trading has not been started for this account, so no pass is scheduled.",
        };
  } else if (state === "idle") {
    reason = { code: blockers[0].code, message: blockers[0].message };
  } else if (state === "error") {
    reason = {
      code: "LAST_PASS_FAILED",
      message:
        row?.lastReasonMessage ??
        `The last pass at ${formatTimestamp(row?.lastEvaluatedAt ?? null)} failed before it could finish.`,
    };
  }

  const headline =
    state === "running"
      ? "SMART TRADING IS RUNNING"
      : state === "idle"
        ? "SMART TRADING IS IDLE"
        : state === "error"
          ? "SMART TRADING NEEDS ATTENTION"
          : row
            ? "SMART TRADING IS STOPPED"
            : "SMART TRADING IS NOT STARTED";

  const openOrders = input.openOrderCount;
  const detail =
    state === "running"
      ? `The runner's last pass is recorded${row?.lastEvaluatedAt ? ` at ${formatTimestamp(row.lastEvaluatedAt)}` : ""}. ` +
        "Any order a pass places keeps its own lifecycle and is reconciled like every other order."
      : state === "idle"
        ? `The activation is saved and will resume by itself, but a pass cannot place: ${reason?.message ?? "configuration is incomplete."}`
        : state === "error"
          ? `The activation is still saved, so the next pass will try again. ${reason?.message ?? ""}`.trim()
          : row?.stoppedAt
            ? `The owner stopped this activation. Nothing is evaluated until it is started again.` +
              (openOrders && openOrders > 0
                ? ` ${openOrders} order(s) already placed are still open: stopping does not cancel them, and reconciliation continues.`
                : " Orders already placed keep their own lifecycle and are reconciled.")
            : "Press start to activate smart trading for this account. It persists immediately and runs on the runner's next pass, with no confirmation step.";

  const placement =
    venue.routing === "live"
      ? {
          mode: "live" as const,
          label: "LIVE PLACEMENT" as const,
          liveExecutionEnabled: true,
          detail:
            "Live execution is switched on in /admin/risk, so a pass that decides to trade sends a real-money order with this account's own key. The switch is the only authorisation.",
        }
      : venue.routing === "testnet"
        ? {
            mode: "testnet" as const,
            label: "TESTNET PLACEMENT" as const,
            liveExecutionEnabled: false,
            detail:
              "Live execution is switched off in /admin/risk, so a pass routes to Binance Spot Testnet: no real funds can move. Testnet routing is on in Access & Integrations.",
          }
        : {
            mode: "paper" as const,
            label: "PAPER PLACEMENT" as const,
            liveExecutionEnabled: false,
            detail:
              "Placement is off for real money: live execution is switched off in /admin/risk (and testnet routing is off in Access & Integrations), so a pass routes to the development paper venue. No exchange is contacted and no real funds move; that one switch is the only thing that changes it.",
          };

  return {
    id: row?.id ?? null,
    state,
    stateLabel: STATE_LABELS[state],
    intent,
    headline,
    detail,
    reason,
    blockers,
    strategy,
    strategyCatalog: input.strategyCatalog ?? [...SMART_STRATEGIES],
    startedAt: isoTimestamp(row?.startedAt ?? null),
    stoppedAt: isoTimestamp(row?.stoppedAt ?? null),
    elapsedMs: intent === "RUNNING" && row?.startedAt ? Math.max(0, now - row.startedAt) : null,
    lastChange: {
      reason: row?.lastChangeReason ?? null,
      at: isoTimestamp(row?.lastChangedAt ?? null),
      by: input.lastChangedByLabel ?? row?.lastChangedBy ?? null,
    },
    lastPass: {
      at: isoTimestamp(row?.lastEvaluatedAt ?? null),
      outcome: row?.lastOutcome ?? null,
      code: row?.lastReasonCode ?? null,
      message: row?.lastReasonMessage ?? null,
      runCount: row?.runCount ?? 0,
    },
    runner,
    placement,
    openOrderCount: openOrders,
    actions: {
      start: {
        label: "START SMART TRADING",
        detail:
          "Activates this account immediately and lets the runner pick it up on its next pass. No confirmation is asked.",
      },
      stop: {
        label: "STOP SMART TRADING",
        detail:
          "Stops evaluating immediately. An order already placed is left to finish and reconcile; stopping cancels and abandons nothing.",
      },
    },
  };
}

/**
 * Whether a press changes anything, decided without a database.
 *
 * Both controls are idempotent, and this is the rule that makes them so: a start while
 * RUNNING and a stop while STOPPED (or before anything was ever started) write nothing,
 * while only the opposite transition does. The persistence functions call this before they
 * open a transaction, so the rule has one implementation and one set of tests.
 */
export type PlannedActivationChange =
  | { write: false; message: string }
  | { write: true; from: string | null; to: StrategyActivationIntent };

/**
 * The strategies a start control offers, in the order it shows them.
 *
 * The catalog is the built-ins plus this account's published bots. Phase 30 made that
 * catalog the way a bot published in the builder becomes startable, so the control has to
 * render it rather than pick from it invisibly: a published bot nobody can select is
 * stored, not startable.
 *
 * The currently selected strategy is listed even when the catalog omits it — a built-in
 * that is already selected is not part of the bot list — because a picker that dropped the
 * running choice would move the account to another strategy on the next press. Every entry
 * appears once, and a catalog that is somehow empty still offers the built-ins rather than
 * an empty select.
 */
export function strategyChoices(input: {
  strategy: SmartStrategy | null;
  strategyCatalog: readonly SmartStrategy[];
}): SmartStrategy[] {
  const seen = new Set<string>();
  const choices: SmartStrategy[] = [];
  for (const candidate of [...(input.strategy ? [input.strategy] : []), ...input.strategyCatalog]) {
    if (seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    choices.push(candidate);
  }
  return choices.length > 0 ? choices : [...SMART_STRATEGIES];
}

/**
 * What a press starts when the owner has not chosen anything.
 *
 * The selected strategy, then the first offered one — null only when there is neither, and
 * null is a real answer: the route then applies its own default rather than the panel
 * inventing an id.
 */
export function defaultStrategyId(input: {
  strategy: SmartStrategy | null;
  strategyCatalog: readonly SmartStrategy[];
}): string | null {
  return input.strategy?.id ?? input.strategyCatalog[0]?.id ?? null;
}

export function planActivationChange(input: {
  action: "start" | "stop";
  currentStatus: string | null;
  strategyLabel?: string | null;
  /**
   * The strategy the activation is on now, and the one a start asks for.
   *
   * A start while running used to be a no-op unconditionally, which was wrong once a bot
   * could be published mid-run: choosing a published bot is how the owner moves from the
   * built-in to their own rules, and answering "already running with <the old one>" left
   * the new choice unapplied while the panel showed the old strategy. Two ids that differ
   * make the start a strategy change; two ids that match (or are both absent) stay the
   * idempotent no-op the phase-23 tests pin.
   */
  currentStrategyId?: string | null;
  nextStrategyId?: string | null;
}): PlannedActivationChange {
  if (input.action === "start") {
    const changing =
      input.currentStrategyId !== undefined &&
      input.nextStrategyId !== undefined &&
      (input.currentStrategyId ?? null) !== (input.nextStrategyId ?? null);
    if (input.currentStatus === "RUNNING" && !changing) {
      return {
        write: false,
        message: `Smart trading is already running${input.strategyLabel ? ` with ${input.strategyLabel}` : ""}. Nothing changed and no second activation was written.`,
      };
    }
    return { write: true, from: input.currentStatus, to: "RUNNING" };
  }
  if (input.currentStatus === null) {
    return {
      write: false,
      message: "Smart trading was not running, so there was nothing to stop. No activation was written.",
    };
  }
  if (input.currentStatus !== "RUNNING") {
    return {
      write: false,
      message: "Smart trading is already stopped. Nothing changed and no second event was written.",
    };
  }
  return { write: true, from: "RUNNING", to: "STOPPED" };
}
