import { listWunderTradingApiProfiles } from "@/lib/wundertrading/client";
import {
  assertWriteAllowed,
  capabilityRefusal,
  VENUE_DESCRIPTORS,
  VENUE_PERMISSION_REPORT_ABSENT,
  type VenueAdapter,
  type VenueBalance,
  type VenueCancellation,
  type VenueHealthCheck,
  type VenueOrder,
  type VenueOrderStatus,
  type VenuePosition,
  type VenueSecret,
} from "./types";

/**
 * WunderTrading through the same interface as an exchange.
 *
 * The temptation this adapter refuses is to make the interface fit by inventing
 * values. WunderTrading is a strategy platform: its documented read surface is API
 * profiles and strategies, and it publishes no spot balance, no order book and no
 * order status. Phase 15 already wrote that down for the import path — "this build
 * will not invent a balance out of a payload whose fields it has not been shown" —
 * and the same rule applies here. So the descriptor claims only `health`, and every
 * other method is refused *by capability* with a sentence that says what the venue
 * actually is.
 *
 * That is still worth having: one connection object, one health answer, one write
 * gate, and a panel that does not branch on the name. The dedicated WunderTrading
 * page keeps the strategy reads, because those answers are its own.
 *
 * The health check is a real authenticated `api_profile:read` call through the
 * existing signed client — the same request the previous verify route made, now
 * measured for latency and recorded on the credential like every other venue.
 */

function healthMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message.slice(0, 280);
  return "WunderTrading did not answer.";
}

function profileItem(value: unknown, index: number): { title: string; detail: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { title: `Profile ${index + 1}`, detail: "" };
  }
  const profile = value as Record<string, unknown>;
  const text = (key: string) => (typeof profile[key] === "string" ? (profile[key] as string) : "");
  const title =
    text("name") || text("label") || text("exchange") || text("exchangeCode") || text("code") || text("id") || `Profile ${index + 1}`;
  const detail = [text("exchange") || text("exchangeCode"), text("status")].filter(Boolean).join(" · ");
  return { title, detail };
}

export function createWunderTradingVenue(secret: VenueSecret): VenueAdapter {
  const descriptor = VENUE_DESCRIPTORS.wundertrading;
  const capabilities = descriptor.capabilities;

  return {
    id: "wundertrading",
    label: descriptor.label,
    capabilities,

    async readBalances(): Promise<VenueBalance[]> {
      return capabilityRefusal("wundertrading", "balances");
    },

    async readPositions(): Promise<VenuePosition[]> {
      return capabilityRefusal("wundertrading", "positions");
    },

    async readOrders(): Promise<VenueOrder[]> {
      return capabilityRefusal("wundertrading", "orders");
    },

    async readOrderStatus(): Promise<VenueOrderStatus> {
      return capabilityRefusal("wundertrading", "orderStatus");
    },

    async cancelOrder(): Promise<VenueCancellation> {
      // The write gate runs first so a read-only key is refused by scope — the reason
      // the owner can fix — rather than by a capability the venue never had.
      assertWriteAllowed("wundertrading", secret, "cancel an order");
      return capabilityRefusal("wundertrading", "cancel");
    },

    async checkHealth(): Promise<VenueHealthCheck> {
      const startedAt = Date.now();
      const checkedAt = new Date().toISOString();
      try {
        const profiles = await listWunderTradingApiProfiles({ apiKey: secret.apiKey, apiSecret: secret.apiSecret });
        return {
          ok: true,
          checkedAt,
          latencyMs: Date.now() - startedAt,
          evidence:
            `${profiles.length} API profile${profiles.length === 1 ? "" : "s"} read. ` +
            "This is WunderTrading's api_profile:read endpoint; it does not report the key's permissions.",
          // Null, not `["read"]`: the venue was not asked, so it did not answer.
          permissions: null,
          items: profiles.map(profileItem),
        };
      } catch (error) {
        return {
          ok: false,
          checkedAt,
          latencyMs: Date.now() - startedAt,
          evidence: VENUE_PERMISSION_REPORT_ABSENT,
          permissions: null,
          error: healthMessage(error),
        };
      }
    },
  };
}
