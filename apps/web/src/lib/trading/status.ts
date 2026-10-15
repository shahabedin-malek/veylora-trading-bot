import { getRiskControlsStatus, type AdjustableRiskPolicy } from "@/lib/risk-controls/policy";
import { getRiskPolicySettings } from "@/lib/risk-controls/settings";

export type RiskPolicyReader = () => Promise<AdjustableRiskPolicy>;

export async function getTradingStatus(readPolicy: RiskPolicyReader = getRiskPolicySettings) {
  const trading = {
    enabled: false as const,
    status: "TRADING DISABLED" as const,
    execution: "OFF" as const,
    detail: "No order route is configured, so no orders can be submitted.",
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