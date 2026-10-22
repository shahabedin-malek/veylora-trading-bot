import { evaluateActiveMarketAlerts } from "@/lib/alerts/evaluate";
import { applyAuditRetention } from "@/lib/audit/retention";
import { verifyAuditChain } from "@/lib/audit/verify";
import { prisma } from "@/lib/db";
import { formatMarketAlertInterval, getEffectiveMarketAlertIntervalMinutes } from "@/lib/alerts/scheduler-config";
import { formatDepositInterval, readDepositPolicy } from "@/lib/deposits/policy";
import { runDepositWatcher } from "@/lib/deposits/service";
import { readWithdrawalPolicy } from "@/lib/withdrawals/policy";
import { runWithdrawalProcessor } from "@/lib/withdrawals/service";
import { assertLedgerInvariants } from "@/lib/ledger/invariants";
import { ledgerStore } from "@/lib/ledger/store";
import { reconcileOrders } from "@/lib/orders/reconcile";
import {
  describeOrderReconcileCadence,
  formatOrderReconcileInterval,
  getOrderReconcileIntervalMinutes,
} from "@/lib/orders/scheduler-config";
import { runMarketBackfill, runMarketIngest } from "@/lib/market-data/ingest";
import { pruneProviderCallRecords, PROVIDER_CALL_RETENTION } from "@/lib/observability/provider-call";
import { parseReason, reason, type Reason } from "@/lib/observability/reason";
import { pruneRunnerInvocations, RUNNER_INVOCATION_RETENTION } from "@/lib/runner/claim";
import { runStrategyDecisionPass } from "@/lib/strategies/runner";
import { deliverPendingWebhooks } from "@/lib/webhooks/dispatch";
import {
  STRATEGY_JOB_DESCRIPTION,
  STRATEGY_JOB_ID,
  STRATEGY_JOB_INTERVAL_MINUTES,
  STRATEGY_JOB_LABEL,
} from "@/lib/strategies/schedule";

/**
 * The work the runner can pick up, declared once.
 *
 * Every job is a named, idempotent unit with its own interval: the runner asks
 * this list what is due, calls `run` for what it claimed, and writes down what
 * happened. Later phases (strategies, orders, alerts) add an entry here rather
 * than another cron route, which is why a job declares its interval itself —
 * the host decides *when the runner is called*, and this list decides *what has
 * actually earned a run*.
 *
 * Two rules hold for every job in this list:
 *
 *  - **Idempotent.** Running it twice for the same period must be safe. The
 *    host makes no timing guarantee (see the note on cadence in
 *    `alerts/scheduler-config.ts`), so a job is written assuming it may be
 *    re-invoked.
 *  - **Explains itself.** A run that did nothing returns a specific reason
 *    instead of a silent success, so the heartbeat can say why.
 */

export type RunnerJobResult = {
  /** One sentence for the summary record: what this run did. */
  summary: string;
  /**
   * Did this run perform the work the job exists to do? False is not a failure:
   * it is a run that correctly found nothing to do, and it must carry a reason.
   */
  worked: boolean;
  /** Why nothing happened, when nothing did. Filled in by the runner when a job leaves it empty. */
  reason?: Reason | null;
  /** Counts and flags the summary keeps. Never a secret, never a user payload. */
  detail: Record<string, number | string | boolean | null>;
};

export type RunnerJobDefinition = {
  id: string;
  label: string;
  /** What the job does, for the admin surface. */
  description: string;
  /** Minutes between runs, resolved from the environment where the owner can set it. */
  intervalMinutes: (env?: NodeJS.ProcessEnv) => number;
  /** The same number said in words. */
  cadence: (env?: NodeJS.ProcessEnv) => string;
  run: () => Promise<RunnerJobResult>;
};

/**
 * The alert evaluation, on the cadence the owner configures.
 *
 * The interval comes from `getEffectiveMarketAlertIntervalMinutes`, the same
 * function the alert evaluation itself uses to decide which alerts are due, so
 * the runner and the evaluation can never disagree about how often this happens.
 */
const marketAlertsJob: RunnerJobDefinition = {
  id: "market-alerts",
  label: "Market alert evaluation",
  description: "Checks every active alert whose interval has elapsed and records the ones that triggered.",
  intervalMinutes: (env) => getEffectiveMarketAlertIntervalMinutes(env),
  cadence: (env) => formatMarketAlertInterval(getEffectiveMarketAlertIntervalMinutes(env)),
  run: async () => {
    const evaluation = await evaluateActiveMarketAlerts();
    const delivery = evaluation.notifications;
    const flushed = evaluation.queue?.delivered ?? 0;
    return {
      summary:
        `${evaluation.evaluated} alert(s) were due, ${evaluation.triggered} triggered, ` +
        `${evaluation.skipped} did not cross their threshold, ${evaluation.failed} could not be checked; ` +
        `${delivery.sent + flushed} notification(s) sent, ${delivery.queued} queued for after quiet hours, ${delivery.failed} failed.`,
      worked: evaluation.evaluated > 0 || flushed > 0,
      // The evaluation already answers "why did nothing happen" with the shared
      // reason type; the runner does not invent a second answer.
      reason: parseReason(evaluation.reason),
      detail: {
        evaluated: evaluation.evaluated,
        triggered: evaluation.triggered,
        skipped: evaluation.skipped,
        failed: evaluation.failed,
        holding: evaluation.holding,
        batchFull: evaluation.batchFull,
        notificationsSent: delivery.sent,
        notificationsQueued: delivery.queued,
        notificationsFailed: delivery.failed,
        notificationsSkipped: delivery.skipped,
        queuedDelivered: flushed,
      },
    };
  },
};

/**
 * Reconciliation: the venue is the truth, and this is the job that makes the
 * local rows agree with it.
 *
 * It walks every order that is not in a terminal state, asks the venue what
 * really happened, applies the corrections the lifecycle allows and records both
 * values wherever the two sides disagreed. It is safe to run twice — a second
 * pass finds the orders already agreeing — which is what lets the host call it
 * whenever it likes without the runner having to coordinate anything.
 */
/**
 * Market ingestion (phase 19).
 *
 * One operation per symbol/interval and one per news source, so a provider that
 * is refusing calls costs the sources that can still answer nothing. Every
 * logical failure is recorded in the health registry and named in the summary;
 * the job's own outcome is a failure only if the run could not be attempted at
 * all, because "Coinbase was rate-limited" and "the runner is broken" are
 * different facts.
 */
const marketIngestJob: RunnerJobDefinition = {
  id: "market-ingest",
  label: "Market data ingestion",
  description:
    "Refreshes stored 15-minute and daily candles for the curated USD markets and the RSS newswire, fills any candle gaps it can, and records each source's health.",
  intervalMinutes: () => MARKET_INGEST_INTERVAL_MINUTES,
  cadence: () => formatMarketAlertInterval(MARKET_INGEST_INTERVAL_MINUTES),
  run: async () => {
    const summary = await runMarketIngest();
    const failed = summary.failures.length;
    return {
      summary:
        `${summary.candlesStored} candle row(s) from ${summary.candlesFetched} fetched, ` +
        `${summary.newsStored} headline(s), ${summary.gapsRestored} gap candle(s) restored; ` +
        `${failed} source operation(s) failed.`,
      worked: summary.worked,
      reason: summary.worked
        ? null
        : failed > 0
          ? reason("PROVIDER_ERROR", {
              retryable: true,
              message: `${failed} market-data source operation(s) failed, so this run stored nothing.`,
            })
          : reason("NO_ENTRY_CONDITION", {
              message: "Every configured market-data source was already current, so ingestion stored nothing new.",
            }),
      detail: {
        symbols: summary.symbols.length,
        intervals: summary.intervals.join(","),
        candlesFetched: summary.candlesFetched,
        candlesStored: summary.candlesStored,
        newsStored: summary.newsStored,
        gapsFound: summary.gapsFound,
        gapsRestored: summary.gapsRestored,
        failedSources: summary.failures.map((failure) => failure.sourceId).join(",") || null,
        skippedSources: summary.skipped.map((entry) => entry.sourceId).join(",") || null,
      },
    };
  },
};

/**
 * Candle backfill (phase 19).
 *
 * The recovery counterpart to ingestion: it fetches nothing when the stored
 * series are complete and asks only for the missing ranges when they are not.
 * The unique key on `MarketCandleRecord` is what makes overlapping runs safe, so
 * this job can be called at any cadence the host can deliver.
 */
const marketBackfillJob: RunnerJobDefinition = {
  id: "market-backfill",
  label: "Market candle backfill",
  description:
    "Checks every maintained candle series for missing slots and restores only those ranges, never duplicating a stored candle.",
  intervalMinutes: () => MARKET_BACKFILL_INTERVAL_MINUTES,
  cadence: () => formatMarketAlertInterval(MARKET_BACKFILL_INTERVAL_MINUTES),
  run: async () => {
    const summary = await runMarketBackfill();
    return {
      summary:
        `${summary.gapsFound} missing range(s) found; ${summary.gapsRestored} candle row(s) restored; ` +
        `${summary.failures.length} source operation(s) failed.`,
      worked: summary.worked,
      reason: summary.worked
        ? null
        : summary.failures.length > 0
          ? reason("PROVIDER_ERROR", {
              retryable: true,
              message: `${summary.failures.length} backfill operation(s) failed before a gap could be restored.`,
            })
          : reason("NO_ENTRY_CONDITION", {
              message: "Every maintained candle series is complete, so there was no gap to backfill.",
            }),
      detail: {
        gapsFound: summary.gapsFound,
        gapsRestored: summary.gapsRestored,
        failedSources: summary.failures.map((failure) => failure.sourceId).join(",") || null,
      },
    };
  },
};

const orderReconciliationJob: RunnerJobDefinition = {
  id: "order-reconciliation",
  label: "Order reconciliation",
  description:
    "Looks up every order that is not terminal at its venue and corrects the local state, recording both values when they disagree.",
  intervalMinutes: (env) => getOrderReconcileIntervalMinutes(env),
  cadence: (env) => describeOrderReconcileCadence(env),
  run: async () => {
    const summary = await reconcileOrders();
    return {
      summary:
        `${summary.checked} open order(s) were checked: ${summary.corrected} corrected, ` +
        `${summary.divergences} disagreed with the venue, ${summary.unresolved} left alone.`,
      worked: summary.checked > 0,
      reason: parseReason(summary.reason),
      detail: {
        checked: summary.checked,
        corrected: summary.corrected,
        divergences: summary.divergences,
        unresolved: summary.unresolved,
        changedOrderIds: summary.changedOrderIds.join(",") || null,
      },
    };
  },
};

/**
 * Smart-trading activation and its 24/7 decision loop (phases 23 and 24).
 *
 * The job the one-click control is wired to: every invocation looks at each account whose
 * intent is RUNNING, evaluates the strategy once per its own interval, and either places
 * one order through the phase-06/20/21 path or records why it did not. The summary states
 * the placement mode, because "idle" on a live account and "idle" on the paper venue are
 * different facts and neither should have to be inferred from a passing test.
 *
 * A pass is idempotent: the window is claimed with one conditional statement and the
 * decision row is unique per window, so a second delivery in the same interval places no
 * second order. A stop that lands mid-pass wins, because the claim and the observation
 * both require the activation to still be RUNNING.
 */
const strategyActivationJob: RunnerJobDefinition = {
  id: STRATEGY_JOB_ID,
  label: STRATEGY_JOB_LABEL,
  description: STRATEGY_JOB_DESCRIPTION,
  intervalMinutes: () => STRATEGY_JOB_INTERVAL_MINUTES,
  cadence: () => formatMarketAlertInterval(STRATEGY_JOB_INTERVAL_MINUTES),
  run: async () => {
    const summary = await runStrategyDecisionPass();
    const placementNote =
      summary.placement === "live"
        ? "Placement is live: a decision to trade moves real money."
        : summary.placement === "testnet"
          ? "Placement is testnet: no real funds can move."
          : "Placement is off for real money: live execution is off in /admin/risk, so passes route to the paper venue.";
    return {
      summary:
        summary.active === 0
          ? `No account has smart trading running, so there was no decision to make. ${placementNote}`
          : `${summary.active} activation(s): ${summary.decided} window(s) decided, ` +
            `${summary.placed} order(s) placed, ${summary.idle} idle, ${summary.error} error, ${summary.gaps} missed window(s) recorded. ${placementNote}`,
      worked: summary.decided > 0,
      reason:
        summary.decided > 0
          ? null
          : reason("NO_ENTRY_CONDITION", {
              message:
                summary.active === 0
                  ? "No account has smart trading running, so there was no decision to make."
                  : "Every running activation's current interval was already decided, so this pass wrote nothing.",
            }),
      detail: {
        ...summary.detail,
        failedAccounts: summary.failures.map((failure) => failure.account).join(",") || null,
        failureMessages: summary.failures.map((failure) => failure.message).join(" | ") || null,
        idleReasons: summary.reasons.join(" | ") || null,
      },
    };
  },
};

/**
 * Webhook retries (phase 31).
 *
 * The first attempt is made when the event happens, so a healthy receiver needs no job. This
 * one exists for the other case: a failed attempt is left with `nextAttemptAt` from the
 * bounded backoff, and this job sends the next attempt when that moment arrives. Every
 * attempt writes its own row, so "it failed, we waited, it failed again" is readable rather
 * than a status field that overwrote the first answer.
 */
const webhookDeliveryJob: RunnerJobDefinition = {
  id: "webhook-deliveries",
  label: "Webhook delivery retries",
  description:
    "Sends every failed webhook attempt whose bounded backoff has elapsed, records the receiver's answer, and marks an endpoint unhealthy after repeated failures.",
  intervalMinutes: () => WEBHOOK_RETRY_INTERVAL_MINUTES,
  cadence: () => formatMarketAlertInterval(WEBHOOK_RETRY_INTERVAL_MINUTES),
  run: async () => {
    const summary = await deliverPendingWebhooks();
    return {
      summary:
        summary.attempted === 0
          ? "No webhook attempt was due for a retry."
          : `${summary.attempted} retry attempt(s) across ${summary.endpoints} endpoint(s): ${summary.delivered} delivered, ${summary.failed} still failing, ${summary.exhausted} exhausted.`,
      worked: summary.attempted > 0,
      reason:
        summary.attempted > 0
          ? null
          : reason("NO_ENTRY_CONDITION", {
              message: "Every webhook delivery is either delivered or waiting for its next bounded-backoff attempt.",
            }),
      detail: {
        attempted: summary.attempted,
        delivered: summary.delivered,
        failed: summary.failed,
        exhausted: summary.exhausted,
        endpoints: summary.endpoints,
      },
    };
  },
};

/**
 * Two tables grow with traffic and have a fixed ceiling, so trimming them is a
 * job rather than a side effect of writing: retention runs on its own cadence and
 * reports how many rows it dropped.
 */
const retentionJob: RunnerJobDefinition = {
  id: "retention",
  label: "Record retention",
  description: `Trims provider call records to ${PROVIDER_CALL_RETENTION} and runner summaries to ${RUNNER_INVOCATION_RETENTION}.`,
  intervalMinutes: () => RETENTION_INTERVAL_MINUTES,
  cadence: () => formatMarketAlertInterval(RETENTION_INTERVAL_MINUTES),
  run: async () => {
    const [providerCalls, invocations] = await Promise.all([
      pruneProviderCallRecords(),
      pruneRunnerInvocations(),
    ]);
    const removed = providerCalls + invocations;
    return {
      summary:
        removed > 0
          ? `${providerCalls} provider call record(s) and ${invocations} runner summary record(s) were removed.`
          : "Every provider call record and runner summary is inside its retention window, so nothing was removed.",
      worked: removed > 0,
      reason:
        removed > 0
          ? null
          : reason("NO_ENTRY_CONDITION", {
              message: "Both record tables are already inside their retention windows, so there was nothing to remove.",
            }),
      detail: {
        providerCallsRemoved: providerCalls,
        invocationsRemoved: invocations,
        providerCallRetention: PROVIDER_CALL_RETENTION,
        invocationRetention: RUNNER_INVOCATION_RETENTION,
      },
    };
  },
};

/**
 * The audit chain's own check (phase 36).
 *
 * A failure is a failed run, not an idle one: a modified row, a broken link or an
 * unexplained gap throws with the first broken index and the row id, so the
 * runner records a failure that names where the trail stopped being trustworthy.
 * Retention runs only after a sound verification, and its own deletion is an
 * audit event, so trimming the trail does not make the next check fail.
 */
const auditIntegrityJob: RunnerJobDefinition = {
  id: "audit-integrity",
  label: "Audit chain integrity",
  description:
    "Verifies the audit hash chain from the first chained row to the tip, names the first modified, broken or unexplained row, and applies the owner's retention window with an audited deletion marker.",
  intervalMinutes: () => AUDIT_INTEGRITY_INTERVAL_MINUTES,
  cadence: () => formatMarketAlertInterval(AUDIT_INTEGRITY_INTERVAL_MINUTES),
  run: async () => {
    const verification = await verifyAuditChain(prisma);
    if (!verification.ok && verification.firstBroken) {
      const broken = verification.firstBroken;
      throw new Error(
        `Audit chain ${broken.kind} at index ${broken.chainIndex}${broken.id ? ` (${broken.id})` : ""}: ${broken.message}`,
      );
    }
    const retention = await applyAuditRetention({
      correlationId: `job:audit-integrity:${new Date().toISOString()}`,
    });
    return {
      summary:
        `${verification.checked} chained event(s) across ${verification.chainLength} row(s) verify; ` +
        `${verification.legacyRows} legacy row(s) predate the chain; ` +
        `${verification.gaps.length} retained gap(s). ` +
        (retention.applied
          ? `Retention removed ${retention.deleted} event(s) older than ${retention.windowDays} day(s) with marker ${retention.markerId}.`
          : retention.windowDays === 0
            ? "Retention is off, so nothing was removed."
            : "Retention found nothing older than its window."),
      worked: verification.checked > 0 || retention.deleted > 0,
      reason:
        verification.checked > 0 || retention.deleted > 0
          ? null
          : reason("NO_ENTRY_CONDITION", {
              message: "The audit chain has not started yet and retention found nothing to remove.",
            }),
      detail: {
        checked: verification.checked,
        chainLength: verification.chainLength,
        headIndex: verification.headIndex,
        headHash: verification.headHash,
        legacyRows: verification.legacyRows,
        gaps: verification.gaps.length,
        retentionWindowDays: retention.windowDays,
        retentionDeleted: retention.deleted,
        retentionMarkerId: retention.markerId,
      },
    };
  },
};

/**
 * The deposit watcher: how money arrives, and when it counts.
 *
 * It reads each enabled network for transfers addressed to an issued deposit
 * address, records what is new (keyed by the chain's own identity for the
 * transfer, so a re-read credits nothing twice) and then credits the pending ones
 * that have reached the confirmation count the owner configured for that network.
 *
 * It is the *only* thing that credits a deposit. Nothing in this job depends on a
 * browser being open, which is the requirement: the same crediting happens
 * whether the owner is looking at the panel or asleep.
 */
const depositWatcherJob: RunnerJobDefinition = {
  id: "deposit-watcher",
  label: "Deposit watcher",
  description:
    "Reads every enabled network for transfers to issued deposit addresses, records them with their confirmations, and credits the ones that have reached the configured count.",
  intervalMinutes: (env) => readDepositPolicy(env).watchIntervalMinutes,
  cadence: (env) => `${formatDepositInterval(readDepositPolicy(env).watchIntervalMinutes)}, and whenever a signed-in account asks for a check`,
  run: async () => {
    const summary = await runDepositWatcher();
    return {
      summary:
        `${summary.networks} network(s), ${summary.scanned} read: ${summary.recorded} transfer(s) recorded, ` +
        `${summary.credited} credited, ${summary.reverted} reverted, ${summary.awaiting} still confirming, ` +
        `${summary.duplicates} already known.`,
      worked: summary.worked,
      reason: summary.reason,
      detail: {
        networks: summary.networks,
        scanned: summary.scanned,
        observations: summary.observations,
        recorded: summary.recorded,
        duplicates: summary.duplicates,
        credited: summary.credited,
        reverted: summary.reverted,
        awaiting: summary.awaiting,
        skippedNetworks: summary.skipped.map((entry) => entry.network).join(",") || null,
        failedNetworks: summary.failed.map((entry) => entry.network).join(",") || null,
        ...summary.detail,
      },
    };
  },
};

/**
 * The ledger's invariants, checked on a cadence.
 *
 * This is the job that makes "losing money cannot happen silently" true rather
 * than aspirational. It adds nothing up from the code that writes movements: it
 * reads the stored rows and asserts that every transaction balances, that each
 * asset's debits equal its credits across the whole book, that no entry is
 * orphaned from its transaction or account, and that no account holder is
 * overdrawn without an explicit credit line.
 *
 * A violation is a **failed run**, not an idle one: the check throws, the runner
 * records the failure with the reason that names the first broken row, and the
 * health signal turns degraded. A run that checks a sound ledger did its work and
 * says how much it looked at.
 */
const ledgerInvariantsJob: RunnerJobDefinition = {
  id: "ledger-invariants",
  label: "Ledger invariants",
  description:
    "Reads the ledger and checks that every transaction balances, that each asset's debits equal its credits, that no entry is orphaned and that no account is overdrawn without a credit line.",
  intervalMinutes: () => LEDGER_INVARIANT_INTERVAL_MINUTES,
  cadence: () => formatMarketAlertInterval(LEDGER_INVARIANT_INTERVAL_MINUTES),
  run: async () => {
    const report = await assertLedgerInvariants(ledgerStore);
    return {
      summary:
        `${report.counts.entries} ledger entr(ies) across ${report.counts.transactions} transaction(s) and ` +
        `${report.counts.accounts} account(s) were checked; every invariant holds.`,
      // A check that ran is a check that worked. Finding a violation does not
      // return here at all: it throws, so the run is recorded as failed with the
      // row that broke it rather than as a job that idled.
      worked: true,
      reason: null,
      detail: {
        accounts: report.counts.accounts,
        transactions: report.counts.transactions,
        entries: report.counts.entries,
        assets: report.totals.length,
        checks: report.checks.length,
        checkedAt: report.checkedAt,
      },
    };
  },
};

/**
 * The withdrawal processor: how money leaves, and what happens when it cannot.
 *
 * It advances every withdrawal that is still in flight, in the order the owner's money
 * requires: a request whose new-address window has passed is queued *and* sent in the same
 * pass; a request that was never sent past its expiry is ended and its amount released; a
 * queued or refused send is attempted again, re-sending the bytes already signed when there
 * are any, which is what makes a retry one transaction rather than two; and a sent transfer
 * is read for its confirmations and settled once the network's count is reached.
 *
 * Nothing here depends on a browser being open, which is the requirement: the same progress
 * happens whether the owner is watching the panel or asleep. Running it twice in parallel is
 * safe — every move is a compare-and-set claim — so the host may call it as often as it likes.
 */
const withdrawalProcessorJob: RunnerJobDefinition = {
  id: "withdrawal-processor",
  label: "Withdrawal processor",
  description:
    "Advances every withdrawal in flight: releases the owner's new-address hold when it expires, sends what is queued, retries a refused send with the bytes already signed, reads confirmations and settles what the chain has confirmed, and releases anything that expired.",
  intervalMinutes: (env) => readWithdrawalPolicy(env).processIntervalMinutes,
  cadence: (env) =>
    `${formatDepositInterval(readWithdrawalPolicy(env).processIntervalMinutes)}, and whenever a signed-in account asks for a check`,
  run: async () => {
    const summary = await runWithdrawalProcessor();
    return {
      summary:
        `${summary.live} withdrawal(s) in flight: ${summary.releasedFromHold} left the hold window, ` +
        `${summary.broadcast} sent, ${summary.broadcastFailed} refused by the network, ${summary.confirmed} confirmed, ` +
        `${summary.cancelled} cancelled, ${summary.failed} failed, ${summary.pending} still waiting.`,
      worked: summary.worked,
      reason: summary.reason,
      detail: summary.detail,
    };
  },
};

/**
 * Market ingestion wants to be frequent, but the host's entry plan can only
 * deliver a daily invocation; the runner honours the interval when it is called
 * and the UI can ask for a refresh directly, so the schedule is a ceiling rather
 * than a broken promise. See `alerts/scheduler-config.ts` for the host facts.
 */
export const MARKET_INGEST_INTERVAL_MINUTES = 15;

/**
 * Backfill is recovery, not freshness: an hourly check is enough to notice a
 * hole, and the unique key makes a repeated run harmless.
 */
export const MARKET_BACKFILL_INTERVAL_MINUTES = 360;

/**
 * Retention is housekeeping, not a promise: it runs on the same daily cadence the
 * host can deliver, and being a day late costs nothing.
 */
export const RETENTION_INTERVAL_MINUTES = 1_440;

/**
 * How often the ledger is verified. An hour is arbitrary and cheap: the check
 * reads the book, which is small, and a violation found within the hour is a
 * violation found before anyone acted on a wrong balance.
 */
export const LEDGER_INVARIANT_INTERVAL_MINUTES = 60;

/** The audit chain is checked hourly; a break found within the hour is a break found early. */
export const AUDIT_INTEGRITY_INTERVAL_MINUTES = 60;

/**
 * Retry cadence. The backoff itself is 30s/120s/600s, so a minute is the finest granularity
 * a host invocation can honour without busy-looping; a delivery due at 10:00:30 is sent at
 * 10:01 rather than late by more than the schedule. This job runs even though no event is due
 * (it reports an idle reason), which is what keeps its own heartbeat honest.
 */
export const WEBHOOK_RETRY_INTERVAL_MINUTES = 1;

export const RUNNER_JOBS: readonly RunnerJobDefinition[] = [
  marketAlertsJob,
  marketIngestJob,
  marketBackfillJob,
  orderReconciliationJob,
  strategyActivationJob,
  depositWatcherJob,
  withdrawalProcessorJob,
  ledgerInvariantsJob,
  webhookDeliveryJob,
  auditIntegrityJob,
  retentionJob,
];

/** The reconciliation job's own interval, exported so a surface can state it without importing the job. */
export const ORDER_RECONCILE_INTERVAL_MINUTES = getOrderReconcileIntervalMinutes();

export { formatOrderReconcileInterval };

export const RUNNER_JOB_IDS: readonly string[] = RUNNER_JOBS.map((job) => job.id);

/** The selector a host or a hand-run uses for every job. */
export const ALL_JOBS = "all";

export function isAllJobs(selector: string | null | undefined): boolean {
  return (selector ?? "").trim().toLowerCase() === ALL_JOBS;
}

export function findRunnerJob(id: string): RunnerJobDefinition | undefined {
  return RUNNER_JOBS.find((job) => job.id === id);
}

/**
 * Turn the URL's job segment into the jobs to run.
 *
 * `unknown` is returned rather than thrown so the caller can answer 404 naming
 * both the unknown segment and the jobs that do exist: a typo in a cron schedule
 * should say what it got wrong.
 */
export function resolveJobSelection(
  selector: string | null | undefined,
  jobs: readonly RunnerJobDefinition[] = RUNNER_JOBS,
): { selected: RunnerJobDefinition[]; unknown: string[] } {
  const value = (selector ?? "").trim().toLowerCase();
  if (!value || isAllJobs(value)) return { selected: [...jobs], unknown: [] };

  const requested = value.split(",").map((part) => part.trim()).filter(Boolean);
  const selected: RunnerJobDefinition[] = [];
  const unknown: string[] = [];
  for (const id of requested) {
    const job = jobs.find((candidate) => candidate.id === id);
    if (job) selected.push(job);
    else unknown.push(id);
  }
  return { selected, unknown };
}
