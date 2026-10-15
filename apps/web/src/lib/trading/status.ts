import { getRiskControlsStatus, type AdjustableRiskPolicy } from "@/lib/risk-controls/policy";
import { getRiskPolicySettings } from "@/lib/risk-controls/settings";

export type RiskPolicyReader = () => Promise<AdjustableRiskPolicy>;

export async function getTradingStatus(readPolicy: RiskPolicyReader = getRiskPolicySettings) {
  // No order route is wired yet, so this is a statement of what the build does, not a
  // gate that holds a finished capability back. Risk evaluation below still runs.
  const trading = {
    enabled: false as const,
    status: "NO ORDER ROUTE" as const,
    execution: "NOT WIRED" as const,
    detail: "Order placement is not wired yet, so no order can be submitted.",
  };

  try {
    const risk = getRiskControlsStatus(await readPolicy());
    return {
      trading,
      riskControls: {
        status: "AVAILABLE" as const,
        detail: risk.detail,
        failClosed: true as const,
        executionEnabled: false as const,
      },
    };
  } catch {
    return {
      trading,
      riskControls: {
        status: "UNAVAILABLE" as const,
        detail: "Database unavailable; risk settings were not loaded",
        failClosed: true as const,
        executionEnabled: false as const,
      },
    };
  }
}