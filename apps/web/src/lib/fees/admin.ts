import { readWithdrawalPolicy } from "@/lib/withdrawals/policy";
import type { FeeScheduleView } from "./table";

/**
 * The payload the admin page and its route both serve.
 *
 * It joins the stored table to the assets a withdrawal can actually send. The form then
 * edits the fees that exist in this deployment instead of a list typed somewhere else,
 * and a deployment that adds a chain gets its new asset's fee row on the next read —
 * with no second price list to update.
 */
export type FeeSchedulePayload = FeeScheduleView & { assets: { asset: string; decimals: number }[] };

/** The assets a fee can be set for: exactly the routes a withdrawal can take. */
export function feeAssets(): { asset: string; decimals: number }[] {
  const policy = readWithdrawalPolicy();
  const seen = new Map<string, number>();
  for (const network of policy.networks) {
    if (!seen.has(network.token.symbol)) seen.set(network.token.symbol, network.token.decimals);
  }
  return [...seen.entries()]
    .map(([asset, decimals]) => ({ asset, decimals }))
    .sort((left, right) => left.asset.localeCompare(right.asset));
}

export function feeSchedulePayload(view: FeeScheduleView): FeeSchedulePayload {
  return { ...view, assets: feeAssets() };
}
