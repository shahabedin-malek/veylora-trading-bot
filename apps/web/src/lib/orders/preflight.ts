import DecimalJS from "decimal.js";
import { ORDER_STATUS_DETAIL } from "@/lib/orders/state-machine";
import type { StoredOrder } from "@/lib/orders/store";
import type { OrderVenuePort } from "@/lib/orders/venue";
import type { RiskPolicySettings } from "@/lib/risk-controls/settings";
import type { OrderVenueCredentialSummary } from "@/lib/venues/registry";
import type { VenueBalance } from "@/lib/venues/types";

/**
 * What a pre-trade evaluation noticed — **reported, never enforced**.
 *
 * Phase 22 is explicit about the direction of this module: the owner's instruction is what
 * authorises an order, so nothing here cancels, delays or drops one. Every check below
 * either produces a sentence for the order response and the audit trail, or reports that
 * it could not be evaluated. Not one of them returns "refuse".
 *
 * That is a deliberate difference from `risk-controls`, which does evaluate and refuse: a
 * policy limit is the owner's own standing instruction about the shape of their trading,
 * while a balance that looks short right now is information. If the venue disagrees — the
 * money is there, or it is not — the venue's answer is the one recorded, verbatim.
 *
 * The checks, in the order they run:
 *
 *  1. **credential** — has this key ever been checked, and did the last check fail? An
 *     unverified key is reported and the order still goes.
 *  2. **venue balance** — what the venue says the account holds, against what the order
 *     needs. A read that fails is a reported outage, not a refusal.
 *  3. **exposure** — open notional from this account's own orders against the configured
 *     open-exposure percentage of the capital the caller declared.
 */

const Decimal = DecimalJS.clone({ precision: 40 });

export type PreflightNoticeCode =
  | "CREDENTIAL_UNVERIFIED"
  | "CREDENTIAL_CHECK_FAILING"
  | "VENUE_OUTAGE"
  | "INSUFFICIENT_VENUE_BALANCE"
  | "EXPOSURE_ABOVE_CONFIGURED_LIMIT"
  | "CAPITAL_UNCONFIGURED";

export type PreflightCheck = {
  name: "credential" | "venue-balance" | "exposure";
  status: "ok" | "notice" | "unavailable" | "not-applicable";
  code?: PreflightNoticeCode;
  detail: string;
};

export type PreTradeReport = {
  evaluatedAt: string;
  /** The subset a surface should show first: everything that is not `ok`. */
  notices: PreflightCheck[];
  checks: PreflightCheck[];
  /** One sentence for the audit trail and the response, always present. */
  summary: string;
};

export type PreTradeInput = {
  venue: OrderVenuePort;
  credential?: OrderVenueCredentialSummary;
  /** Null when the risk-policy row could not be read; the exposure check says so. */
  policy: RiskPolicySettings | null;
  order: {
    market: string;
    side: "BUY" | "SELL";
    quantity: string;
    notionalUsdCents: number;
    verifiedBalanceCents: number;
  };
  /** This account's orders, read from the order store; never throws for the caller. */
  openOrders: () => Promise<StoredOrder[]>;
  now?: () => Date;
};

type BalanceReader = { readBalances(): Promise<VenueBalance[]> };

function decimal(value: string | number): InstanceType<typeof Decimal> | null {
  const parsed = new Decimal(String(value));
  return parsed.isFinite() ? parsed : null;
}

function credentialCheck(credential: OrderVenueCredentialSummary | undefined): PreflightCheck {
  if (!credential) {
    return {
      name: "credential",
      status: "not-applicable",
      detail: "The paper venue needs no key, so there is no credential to report on.",
    };
  }
  if (credential.lastCheckError) {
    return {
      name: "credential",
      status: "notice",
      code: "CREDENTIAL_CHECK_FAILING",
      detail: `The last check of the key "${credential.label}" failed: ${credential.lastCheckError}. The order was still sent.`,
    };
  }
  if (!credential.verifiedAt) {
    return {
      name: "credential",
      status: "notice",
      code: "CREDENTIAL_UNVERIFIED",
      detail: `The key "${credential.label}" has not been verified against the venue, so its permissions are unconfirmed. The order was still sent.`,
    };
  }
  return {
    name: "credential",
    status: "ok",
    detail: `The key "${credential.label}" was verified at ${credential.verifiedAt}.`,
  };
}

async function balanceCheck(input: PreTradeInput, quoteAsset: string | null): Promise<PreflightCheck> {
  const reader = input.venue as Partial<BalanceReader>;
  if (typeof reader.readBalances !== "function") {
    return {
      name: "venue-balance",
      status: "not-applicable",
      detail: `${input.venue.id} does not report balances through this connection, so none were read.`,
    };
  }

  let balances: VenueBalance[];
  try {
    balances = await reader.readBalances();
  } catch (error) {
    return {
      name: "venue-balance",
      status: "unavailable",
      code: "VENUE_OUTAGE",
      detail:
        `The venue balance could not be read (${error instanceof Error && error.message ? error.message.slice(0, 200) : "no answer"}), ` +
        "so it is reported as an outage rather than a shortfall. The order was still sent.",
    };
  }

  const quote = quoteAsset ?? input.order.market.split("-")[1] ?? "USD";
  const base = input.order.market.split("-")[0] ?? "";
  const available = (asset: string) => {
    const row = balances.find((candidate) => candidate.asset.toUpperCase() === asset.toUpperCase());
    return row ? decimal(row.available) : null;
  };

  if (input.order.side === "SELL") {
    const held = available(base);
    const wanted = decimal(input.order.quantity);
    if (held !== null && wanted !== null && held.lessThan(wanted)) {
      return {
        name: "venue-balance",
        status: "notice",
        code: "INSUFFICIENT_VENUE_BALANCE",
        detail: `The venue reports ${held.toFixed()} ${base} available and the order asks to sell ${wanted.toFixed()}. The order was still sent, and the venue's own answer is what counts.`,
      };
    }
    return {
      name: "venue-balance",
      status: "ok",
      detail: held === null
        ? `The venue reports no ${base} balance at all; the order was still sent.`
        : `The venue reports ${held.toFixed()} ${base} available for a ${input.order.quantity} sale.`,
    };
  }

  const held = available(quote);
  const needed = new Decimal(input.order.notionalUsdCents).div(100);
  if (held !== null && held.lessThan(needed)) {
    return {
      name: "venue-balance",
      status: "notice",
      code: "INSUFFICIENT_VENUE_BALANCE",
      detail: `The venue reports ${held.toFixed()} ${quote} available and the order is worth ${needed.toFixed(2)} ${quote}. The order was still sent, and the venue's own answer is what counts.`,
    };
  }
  return {
    name: "venue-balance",
    status: "ok",
    detail: held === null
      ? `The venue reports no ${quote} balance; the order asks for ${needed.toFixed(2)} ${quote}, and it was still sent.`
      : `The venue reports ${held.toFixed()} ${quote} available for an order worth ${needed.toFixed(2)} ${quote}.`,
  };
}

async function exposureCheck(input: PreTradeInput): Promise<PreflightCheck> {
  if (!input.policy) {
    return {
      name: "exposure",
      status: "unavailable",
      detail:
        "The risk policy could not be read, so the configured open-exposure percentage is unknown and nothing was " +
        "compared. The order was still sent.",
    };
  }
  const capital = new Decimal(input.order.verifiedBalanceCents).div(100);
  const notional = new Decimal(input.order.notionalUsdCents).div(100);
  if (capital.lessThanOrEqualTo(0)) {
    return {
      name: "exposure",
      status: "notice",
      code: "CAPITAL_UNCONFIGURED",
      detail:
        "No capital was declared with this order, so the configured open-exposure percentage cannot be applied. " +
        "The order was still sent; phase 25 supplies a server-computed capital figure.",
    };
  }

  let open = new Decimal(0);
  try {
    const orders = await input.openOrders();
    for (const order of orders) {
      if (ORDER_STATUS_DETAIL[order.status].terminal) continue;
      open = open.plus(new Decimal(order.notionalUsdCents).div(100));
    }
  } catch (error) {
    return {
      name: "exposure",
      status: "unavailable",
      detail: `Open exposure could not be read (${error instanceof Error && error.message ? error.message.slice(0, 200) : "no answer"}), so it was not compared with the configured limit. The order was still sent.`,
    };
  }

  const limit = capital.mul(input.policy.maxOpenExposurePercent).div(100);
  if (open.plus(notional).greaterThan(limit)) {
    return {
      name: "exposure",
      status: "notice",
      code: "EXPOSURE_ABOVE_CONFIGURED_LIMIT",
      detail:
        `Open exposure of ${open.toFixed(2)} plus this order's ${notional.toFixed(2)} exceeds the configured ` +
        `${input.policy.maxOpenExposurePercent}% limit (${limit.toFixed(2)} of ${capital.toFixed(2)}). ` +
        "Reported for the owner: the order was still sent.",
    };
  }
  return {
    name: "exposure",
    status: "ok",
    detail: `Open exposure of ${open.toFixed(2)} plus ${notional.toFixed(2)} is within ${limit.toFixed(2)} (${input.policy.maxOpenExposurePercent}% of ${capital.toFixed(2)}).`,
  };
}

function summarise(checks: readonly PreflightCheck[], venueId: string): string {
  const noticed = checks.filter((check) => check.status === "notice" || check.status === "unavailable");
  if (noticed.length === 0) {
    return `Pre-trade report for ${venueId}: every check passed and nothing needed the owner's attention.`;
  }
  return `Pre-trade report for ${venueId}: ${noticed.length} item${noticed.length === 1 ? "" : "s"} reported and none of them stopped the order — ${noticed
    .map((check) => check.code ?? check.name)
    .join(", ")}.`;
}

/**
 * Build the report. It cannot throw: a check that fails is a `notice` or an `unavailable`,
 * and the caller can always answer with something honest.
 */
export async function buildPreTradeReport(input: PreTradeInput): Promise<PreTradeReport> {
  const evaluatedAt = (input.now ?? (() => new Date()))().toISOString();
  const quoteAsset = input.venue.quoteAssetFor?.(input.order.market) ?? null;
  const checks: PreflightCheck[] = [
    credentialCheck(input.credential),
    await balanceCheck(input, quoteAsset).catch((error: unknown) => ({
      name: "venue-balance" as const,
      status: "unavailable" as const,
      code: "VENUE_OUTAGE" as const,
      detail: `The balance check could not run (${error instanceof Error ? error.message.slice(0, 200) : "no answer"}). The order was still sent.`,
    })),
    await exposureCheck(input).catch((error: unknown) => ({
      name: "exposure" as const,
      status: "unavailable" as const,
      detail: `The exposure check could not run (${error instanceof Error ? error.message.slice(0, 200) : "no answer"}). The order was still sent.`,
    })),
  ];

  return {
    evaluatedAt,
    checks,
    notices: checks.filter((check) => check.status === "notice" || check.status === "unavailable"),
    summary: summarise(checks, input.venue.id),
  };
}
