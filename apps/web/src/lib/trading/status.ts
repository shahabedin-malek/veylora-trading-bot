import { developmentDetail } from "@/lib/dev-mode/development-detail";
import { ORDER_STATUS_DETAIL } from "@/lib/orders/state-machine";
import { describeOrderRetryPolicy } from "@/lib/orders/process";
import { describeOrderReconcileCadence, getOrderReconcileIntervalMinutes } from "@/lib/orders/scheduler-config";
import { orderVenueSummary, type OrderVenueSummary } from "@/lib/venues/registry";
import { getRiskControlsStatus, type AdjustableRiskPolicy } from "@/lib/risk-controls/policy";
import { getRiskPolicySettings } from "@/lib/risk-controls/settings";

export type RiskPolicyReader = () => Promise<AdjustableRiskPolicy>;

/** Where orders would go, injectable so a test needs no settings row. */
export type OrderVenueReader = () => Promise<OrderVenueSummary>;

/**
 * What trading can actually do right now, said plainly.
 *
 * This function exists so the surface has one place to ask that question, and so
 * the answer cannot drift from the code: the venue, its paper/live nature, the
 * retry policy, the reconciliation cadence and the lifecycle are all read from
 * the modules that implement them rather than restated here.
 *
 * `executionEnabled: false` now means **live execution**, not "no orders": paper
 * orders are placed, retried, cancelled and reconciled, and
 * `paperExecutionEnabled` says so. Keeping the two apart is the point — a single
 * boolean would have to be wrong about one of them.
 */
export async function getTradingStatus(
  readPolicy: RiskPolicyReader = getRiskPolicySettings,
  readVenue: OrderVenueReader = orderVenueSummary,
) {
  // Phase 21: where an order goes is admin data (the testnet switch) plus the signed-in
  // account's own key, so the surface asks the registry rather than guessing from a
  // module-level singleton. The default answer when the settings cannot be read is the
  // paper venue *with `available: false`*: nothing can be sent, and the sentence says so.
  const summary = await readVenue();
  const live = summary.environment === "live";
  const testnet = summary.environment === "testnet";
  const trading = {
    enabled: true as const,
    status: live
      ? ("LIVE ORDERS" as const)
      : testnet
        ? ("TESTNET ORDERS" as const)
        : ("PAPER ORDERS" as const),
    execution: live
      ? ("LIVE VENUE" as const)
      : testnet
        ? ("TESTNET VENUE" as const)
        : ("PAPER VENUE" as const),
    detail: summary.detail,
    venue: {
      id: summary.venueId,
      label: summary.label,
      environment: summary.environment,
      paper: summary.environment === "paper",
      testnetRoutingEnabled: summary.testnetRoutingEnabled,
      liveExecutionEnabled: summary.liveExecutionEnabled,
      available: summary.available,
    },
    retry: describeOrderRetryPolicy(),
    reconciliation: {
      intervalMinutes: getOrderReconcileIntervalMinutes(),
      cadence: describeOrderReconcileCadence(),
      detail:
        "Any order that is not terminal is looked up at the venue on the runner's next pass. When the two disagree, both values are written to the audit trail.",
    },
    /**
     * The two switches, read from the routing summary rather than restated: phase 22's
     * live switch is owner data in /admin/risk, and a status line quoting a constant is
     * the one place the owner could not tell whether they had turned it on.
     */
    liveExecutionEnabled: summary.liveExecutionEnabled,
    testnetExecutionEnabled: summary.testnetRoutingEnabled,
    lifecycle: Object.entries(ORDER_STATUS_DETAIL).map(([status, detail]) => ({
      status,
      label: detail.label,
      detail: detail.detail,
      terminal: detail.terminal,
    })),
  };

  try {
    const risk = getRiskControlsStatus(await readPolicy(), { liveExecutionEnabled: summary.liveExecutionEnabled });
    return {
      trading,
      riskControls: {
        status: "AVAILABLE" as const,
        detail: risk.detail,
        failClosed: true as const,
        // "executionEnabled" has always meant live execution; it is now read from the
        // owner's switch instead of being hard-coded off.
        executionEnabled: summary.liveExecutionEnabled,
        paperExecutionEnabled: true as const,
      },
    };
  } catch (error) {
    return {
      trading,
      riskControls: {
        status: "UNAVAILABLE" as const,
        // Production keeps the generic sentence; development appends the real
        // message so a failed policy read says why, not just that it failed.
        detail: developmentDetail(error, "Database unavailable; risk settings were not loaded"),
        failClosed: true as const,
        executionEnabled: summary.liveExecutionEnabled,
        paperExecutionEnabled: true as const,
      },
    };
  }
}
