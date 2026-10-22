import { isDevelopmentMode } from "@/lib/dev-mode/mode";
import { readDepositPolicy, type DepositNetworkPolicy, type DepositPolicy } from "@/lib/deposits/policy";
import { LedgerAmountError, minorUnitsFromDecimalString, type MinorUnits } from "@/lib/ledger/integer-cent-ledger";
import { reason, type Reason } from "@/lib/observability/reason";
import { rpcConfigurationVariableName } from "@/lib/rpc/networks";

/**
 * The withdrawal policy the owner edits, as data.
 *
 * Every value below is a named environment value resolved in one place, so no
 * surface invents its own default and the panel, the API and the runner all describe
 * the same withdrawal route:
 *
 *   WITHDRAWAL_HOT_WALLET_MNEMONIC      the BIP-39 seed the sending wallet derives from
 *   WITHDRAWAL_HOT_WALLET_INDEX         which account of that seed sends (default 0)
 *   WITHDRAWAL_FEE_<ASSET>              the platform's cut, in whole units (default 0)
 *   WITHDRAWAL_NEW_ADDRESS_WINDOW_MINUTES  how long a first send to an unseen address is
 *                                       held; **0 holds nothing** (default 60)
 *   WITHDRAWAL_REQUEST_EXPIRY_MINUTES   how long an unsent request may sit before it
 *                                       expires and the amount is released
 *                                       (default 10080 — seven days — and the unit is
 *                                       minutes, which is what the name says)
 *   WITHDRAWAL_CANCEL_AFTER_MINUTES     how long a sent-but-unconfirmed withdrawal must
 *                                       be unconfirmed before the owner may cancel it
 *                                       (default 60)
 *   WITHDRAWAL_BROADCAST_MODE           `onchain` or `simulated`; `simulated` is the
 *                                       default in development and is refused anywhere
 *                                       else (see below)
 *   WITHDRAWAL_SIMULATE_FAILURE         development only: make a send take a failure
 *                                       path by hand. `rpc-unavailable` and
 *                                       `nonce-conflict` fail the send itself, so the row
 *                                       is left BROADCAST_FAILED with the amount still
 *                                       reserved and the next pass retries it; `reverted`
 *                                       mines and reverts, so the row ends FAILED and the
 *                                       amount is released
 *
 * **The network list is the deposit policy's, not a second registry.** Which chains
 * this deployment can send on is exactly the question "which chains does it hold a
 * token on, with an address and an RPC endpoint for", and phase 12 already answers
 * it. A second list would let a withdrawal route exist for a network with no way to
 * receive the money back, and the two would drift. So a network is withdrawable when
 * the deposit policy says it is `ready`, the confirmation count is the same number
 * the deposit watcher waits for, and the token contract is the one a deposit would
 * have arrived in. A network that is not ready is reported with the variable that
 * would fix it rather than as "unsupported" alone.
 *
 * **The fee's *amount* is phase 16's table; this file holds the shape of it.** The
 * environment values below remain the deployment defaults for a deployment whose fee
 * table cannot be read at all, and they are what a unit test hands the request path
 * directly. A withdrawal that is actually requested is priced by
 * `readPricedWithdrawalPolicy`, which overlays the stored schedule on top — so the
 * number charged and the number on `/pricing` come from one row. The scale is the
 * network's own token's: `1` on a 6-decimal token is 1 USDT and on an 18-decimal one
 * it is 1 BSC-USD, rather than one minor-unit string meaning different money on
 * different chains.
 *
 * **A simulated broadcast is development-only and says so.** Moving money on a real
 * chain from this process is the one thing this code cannot do on a machine with no
 * funded key, so development gets a deterministic stand-in, exactly as the paper
 * venue stands in for an exchange: it signs the same request, sends it to a
 * simulation that mines it after a fixed number of polls, and is refused outside
 * `NODE_ENV=development`. The panel and the proof both name which mode is live, so a
 * simulated confirmation can never be mistaken for a real one.
 */

export const WITHDRAWAL_HOT_WALLET_MNEMONIC_VARIABLE = "WITHDRAWAL_HOT_WALLET_MNEMONIC";
export const WITHDRAWAL_HOT_WALLET_INDEX_VARIABLE = "WITHDRAWAL_HOT_WALLET_INDEX";
export const WITHDRAWAL_NEW_ADDRESS_WINDOW_VARIABLE = "WITHDRAWAL_NEW_ADDRESS_WINDOW_MINUTES";
export const WITHDRAWAL_REQUEST_EXPIRY_VARIABLE = "WITHDRAWAL_REQUEST_EXPIRY_MINUTES";
export const WITHDRAWAL_CANCEL_AFTER_VARIABLE = "WITHDRAWAL_CANCEL_AFTER_MINUTES";
export const WITHDRAWAL_BROADCAST_MODE_VARIABLE = "WITHDRAWAL_BROADCAST_MODE";
export const WITHDRAWAL_SIMULATE_FAILURE_VARIABLE = "WITHDRAWAL_SIMULATE_FAILURE";
export const WITHDRAWAL_PROCESS_INTERVAL_VARIABLE = "WITHDRAWAL_PROCESS_INTERVAL_MINUTES";

/** Minutes between withdrawal passes, before the owner's own number applies. */
export const DEFAULT_WITHDRAWAL_PROCESS_INTERVAL_MINUTES = 2;

/** A first withdrawal to an unseen address is held this long, before the owner says otherwise. */
export const DEFAULT_NEW_ADDRESS_WINDOW_MINUTES = 60;
/** An unsent request expires after this long, before the owner says otherwise. */
export const DEFAULT_REQUEST_EXPIRY_MINUTES = 7 * 24 * 60;
/** A sent-but-unconfirmed withdrawal may be cancelled after this long. */
export const DEFAULT_CANCEL_AFTER_MINUTES = 60;
/** The platform's cut of a withdrawal, before the owner says otherwise. */
export const DEFAULT_WITHDRAWAL_FEE = "0";

export const WITHDRAWAL_BROADCAST_MODES = ["onchain", "simulated"] as const;
export type WithdrawalBroadcastMode = (typeof WITHDRAWAL_BROADCAST_MODES)[number];

/** How the next send is made to fail by hand, in development only. */
export const WITHDRAWAL_SIMULATED_FAILURES = ["rpc-unavailable", "nonce-conflict", "reverted"] as const;
export type WithdrawalSimulatedFailure = (typeof WITHDRAWAL_SIMULATED_FAILURES)[number];

export type WithdrawalNetworkPolicy = {
  slug: string;
  chainId: number;
  /** The Alchemy network slug this chain's reads and sends resolve through. */
  alchemyNetwork: string;
  displayName: string;
  /** The token a withdrawal on this network sends, and the scale its amounts use. */
  token: { symbol: string; displayName: string; address: string; decimals: number; note?: string };
  /** Confirmations before the transfer counts as done. The deposit policy's number. */
  confirmations: number;
};

/**
 * Where the new-address window in force came from.
 *
 * The owner's stored setting and this deployment's environment value are the only two
 * answers, and the difference is worth reporting: a person reading the panel should know
 * whether they are looking at a number they can change on the admin page or one that only
 * moves with the deployment. A stored row always wins.
 */
export type WithdrawalWindowSource = "owner-setting" | "deployment-default";

export type WithdrawalPolicy = {
  hotWalletMnemonic: string | null;
  hotWalletIndex: number;
  newAddressWindowMinutes: number;
  /** Which of the two places the window above came from. */
  newAddressWindowSource: WithdrawalWindowSource;
  /**
   * The owner's stop switch. True refuses every new request and stops the processor
   * sending a reserved one; it is never an approval step on an individual withdrawal.
   * The deployment value is always false — only a stored owner setting can pause.
   */
  withdrawalsPaused: boolean;
  requestExpiryMinutes: number;
  cancelAfterMinutes: number;
  broadcastMode: WithdrawalBroadcastMode;
  simulatedFailure: WithdrawalSimulatedFailure | null;
  /** The fee per asset, in whole units, as configured. */
  feeByAsset: Record<string, string>;
  /**
   * What the chain costs to send one unit, disclosed beside the fee. Never deducted:
   * the owner authorises a gross amount and the platform pays the gas.
   */
  networkCostByAsset: Record<string, string>;
  /**
   * Which source priced this policy: a stored fee-table version, this build's free
   * defaults when no version exists, or the deployment's own values when the table
   * could not be read at all. A person reading a quote is entitled to know which.
   */
  feeSource: "owner-schedule" | "free-defaults" | "deployment-default";
  networks: WithdrawalNetworkPolicy[];
  /** Environment values that are set but unusable, each with a sentence. */
  problems: string[];
  /** Minutes between passes of the withdrawal processor. */
  processIntervalMinutes: number;
  /** The deposit policy this was derived from, so a caller can read the deficits. */
  source: DepositPolicy;
};

/** `WITHDRAWAL_FEE_USDT` — the asset uppercased with anything unusable replaced. */
export function withdrawalFeeVariable(asset: string): string {
  return `WITHDRAWAL_FEE_${asset.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
}

function isDecimal(value: string): boolean {
  return /^\d+(\.\d+)?$/.test(value.trim());
}

function readPositiveMinutes(raw: string | undefined, fallback: number, name: string, problems: string[]): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw.trim());
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    problems.push(`${name} must be a whole number of minutes, 0 or more.`);
    return fallback;
  }
  return parsed;
}

/**
 * Read the whole policy. Pure: it reads only the environment it is handed, so every
 * status below is testable without a chain, a database or a deployment.
 */
export function readWithdrawalPolicy(env: NodeJS.ProcessEnv = process.env): WithdrawalPolicy {
  const problems: string[] = [];
  const source = readDepositPolicy(env);

  const networks: WithdrawalNetworkPolicy[] = source.networks
    // Only a network whose token this deployment knows can carry a withdrawal: the
    // transfer has to name a contract, and the amount has to have a scale.
    .filter((network): network is DepositNetworkPolicy & { token: NonNullable<DepositNetworkPolicy["token"]> } => network.token !== null)
    .map((network) => ({
      slug: network.slug,
      chainId: network.chainId,
      alchemyNetwork: network.alchemyNetwork,
      displayName: network.displayName,
      confirmations: network.confirmations,
      token: {
        symbol: network.token.symbol,
        displayName: network.token.displayName,
        address: network.token.address,
        decimals: network.token.decimals,
        ...(network.token.note ? { note: network.token.note } : {}),
      },
    }));

  const mnemonic = env[WITHDRAWAL_HOT_WALLET_MNEMONIC_VARIABLE]?.trim() || null;

  const indexRaw = env[WITHDRAWAL_HOT_WALLET_INDEX_VARIABLE];
  let hotWalletIndex = 0;
  if (indexRaw !== undefined && indexRaw.trim() !== "") {
    const parsed = Number(indexRaw.trim());
    if (Number.isSafeInteger(parsed) && parsed >= 0) hotWalletIndex = parsed;
    else problems.push(`${WITHDRAWAL_HOT_WALLET_INDEX_VARIABLE} must be a whole number, 0 or more.`);
  }

  const feeByAsset: Record<string, string> = {};
  const networkCostByAsset: Record<string, string> = {};
  for (const network of networks) {
    const symbol = network.token.symbol;
    if (feeByAsset[symbol] !== undefined) continue;
    const variable = withdrawalFeeVariable(symbol);
    const raw = env[variable];
    // The network cost has no environment variable of its own: it is a value the fee
    // table owns, and a deployment with no table discloses nothing rather than
    // inventing a gas estimate.
    networkCostByAsset[symbol] = "0";
    if (raw === undefined || raw.trim() === "") {
      feeByAsset[symbol] = DEFAULT_WITHDRAWAL_FEE;
      continue;
    }
    if (!isDecimal(raw)) {
      problems.push(`${variable} must be a decimal amount, for example 1 or 0.5.`);
      feeByAsset[symbol] = DEFAULT_WITHDRAWAL_FEE;
      continue;
    }
    feeByAsset[symbol] = raw.trim();
  }

  const modeRaw = env[WITHDRAWAL_BROADCAST_MODE_VARIABLE]?.trim().toLowerCase();
  const requestedMode: WithdrawalBroadcastMode | null =
    modeRaw === "onchain" || modeRaw === "simulated" ? modeRaw : null;
  if (modeRaw && !requestedMode) {
    problems.push(`${WITHDRAWAL_BROADCAST_MODE_VARIABLE} must be "onchain" or "simulated".`);
  }
  // A simulated broadcast is a development affordance and nothing else. Asking for
  // one in production is refused by falling back to the real chain, and the panel
  // says which mode is live rather than reporting a confirmation it did not get.
  const development = isDevelopmentMode(env);
  const broadcastMode: WithdrawalBroadcastMode = requestedMode === "simulated" && development
    ? "simulated"
    : requestedMode === "onchain"
      ? "onchain"
      : development
        ? "simulated"
        : "onchain";
  if (requestedMode === "simulated" && !development) {
    problems.push(
      `${WITHDRAWAL_BROADCAST_MODE_VARIABLE} asked for a simulated broadcast, which is a development affordance only; withdrawals will be broadcast on chain.`,
    );
  }

  const failureRaw = env[WITHDRAWAL_SIMULATE_FAILURE_VARIABLE]?.trim().toLowerCase();
  const simulatedFailure =
    development && (WITHDRAWAL_SIMULATED_FAILURES as readonly string[]).includes(failureRaw ?? "")
      ? (failureRaw as WithdrawalSimulatedFailure)
      : null;

  return {
    hotWalletMnemonic: mnemonic,
    hotWalletIndex,
    newAddressWindowSource: "deployment-default",
    withdrawalsPaused: false,
    newAddressWindowMinutes: readPositiveMinutes(
      env[WITHDRAWAL_NEW_ADDRESS_WINDOW_VARIABLE],
      DEFAULT_NEW_ADDRESS_WINDOW_MINUTES,
      WITHDRAWAL_NEW_ADDRESS_WINDOW_VARIABLE,
      problems,
    ),
    requestExpiryMinutes: readPositiveMinutes(
      env[WITHDRAWAL_REQUEST_EXPIRY_VARIABLE],
      DEFAULT_REQUEST_EXPIRY_MINUTES,
      WITHDRAWAL_REQUEST_EXPIRY_VARIABLE,
      problems,
    ),
    cancelAfterMinutes: readPositiveMinutes(
      env[WITHDRAWAL_CANCEL_AFTER_VARIABLE],
      DEFAULT_CANCEL_AFTER_MINUTES,
      WITHDRAWAL_CANCEL_AFTER_VARIABLE,
      problems,
    ),
    broadcastMode,
    simulatedFailure,
    feeByAsset,
    networkCostByAsset,
    feeSource: "deployment-default",
    processIntervalMinutes: readPositiveMinutes(
      env[WITHDRAWAL_PROCESS_INTERVAL_VARIABLE],
      DEFAULT_WITHDRAWAL_PROCESS_INTERVAL_MINUTES,
      WITHDRAWAL_PROCESS_INTERVAL_VARIABLE,
      problems,
    ),
    networks,
    problems,
    source,
  };
}

/**
 * The first reason a withdrawal cannot be offered at all, or null when one can.
 *
 * One sentence naming the variable to set. A withdrawal needs somewhere to send
 * from and somewhere to send: without a hot wallet seed no transaction can be
 * signed, and without a ready network there is no token contract to send. Both are
 * configuration gaps, and saying which is the difference between an owner fixing it
 * and an owner guessing.
 */
export function withdrawalAvailabilityReason(policy: WithdrawalPolicy): Reason | null {
  if (!policy.hotWalletMnemonic) {
    return reason("MISSING_CONFIGURATION", {
      variable: WITHDRAWAL_HOT_WALLET_MNEMONIC_VARIABLE,
      message: `${WITHDRAWAL_HOT_WALLET_MNEMONIC_VARIABLE} is not configured, so no sending wallet exists and nothing can be signed.`,
    });
  }
  if (policy.networks.length === 0) {
    return reason("MISSING_CONFIGURATION", {
      message:
        "No network is configured with a withdrawal token, so there is no route to send on. Enable a deposit network and set its token.",
    });
  }
  return null;
}

/**
 * The policy row for one network, or the reason it cannot be used.
 *
 * A slug this build does not know and a slug it knows but cannot send on are
 * different sentences: the first is a typo, the second names the variable that would
 * fix it. Both are `NETWORK_UNSUPPORTED` to the caller, which is what the owner sees.
 */
export function withdrawalNetworkFor(
  slug: string,
  policy: WithdrawalPolicy,
): { ok: true; network: WithdrawalNetworkPolicy } | { ok: false; reason: Reason } {
  const known = policy.source.networks.find((network) => network.slug === slug);
  if (!known) {
    return {
      ok: false,
      reason: reason("NETWORK_UNSUPPORTED", {
        message: `This deployment does not know a network called ${JSON.stringify(slug)}, so there is nothing to send on.`,
      }),
    };
  }
  const usable = policy.networks.find((network) => network.slug === slug);
  if (!usable) {
    return {
      ok: false,
      reason: reason("NETWORK_UNSUPPORTED", {
        variable: known.missing[0] ?? rpcConfigurationVariableName(known.alchemyNetwork) ?? undefined,
        message:
          known.token === null
            ? `${known.displayName} has no withdrawal token configured, so a withdrawal cannot be sent on it.`
            : `${known.displayName} is not ready to send on: ${known.problems[0] ?? known.missing[0] ?? "see the deposit policy"}.`,
      }),
    };
  }
  if (known.status !== "ready") {
    return {
      ok: false,
      reason: reason("NETWORK_UNSUPPORTED", {
        variable: known.missing[0] ?? known.problems[0] ?? undefined,
        message:
          known.status === "disabled"
            ? `${known.displayName} is not enabled for this deployment, so a withdrawal cannot be sent on it.`
            : `${known.displayName} is not ready to send on: ${known.problems[0] ?? known.missing[0] ?? "see the deposit policy"}.`,
      }),
    };
  }
  return { ok: true, network: usable };
}

/**
 * The configured fee for one asset at one network's scale, in minor units.
 *
 * Returns the refusal rather than throwing, because "the fee is misconfigured" and
 * "the fee is zero" are both answers a request has to act on, and phase 16's
 * schedule will resolve through this same door.
 */
export function withdrawalFeeMinor(
  policy: WithdrawalPolicy,
  input: { asset: string; decimals: number },
): { ok: true; minor: MinorUnits } | { ok: false; reason: Reason } {
  const configured = policy.feeByAsset[input.asset] ?? DEFAULT_WITHDRAWAL_FEE;
  try {
    return { ok: true, minor: minorUnitsFromDecimalString(configured, input.decimals) };
  } catch (error) {
    // Where the unreadable number came from is part of the answer: an owner who set it
    // on the fee table must not be told to change an environment variable they cannot
    // see, and a deployment still on its environment defaults must be told exactly which
    // one to change.
    const fromSchedule = policy.feeSource === "owner-schedule";
    return {
      ok: false,
      reason: reason("MISSING_CONFIGURATION", {
        ...(fromSchedule ? {} : { variable: withdrawalFeeVariable(input.asset) }),
        message:
          `The configured withdrawal fee ${JSON.stringify(configured)} for ${input.asset} ` +
          `(${fromSchedule ? "from the fee table" : `from ${withdrawalFeeVariable(input.asset)}`}) cannot be read at ` +
          `${input.decimals} decimals${error instanceof LedgerAmountError ? ` (${error.code})` : ""}, so no withdrawal can be priced.`,
      }),
    };
  }
}

/** The fee as a person reads it, for the panel's summary line. */
export function withdrawalFeeLabel(asset: string, policy: WithdrawalPolicy): string {
  return policy.feeByAsset[asset] ?? DEFAULT_WITHDRAWAL_FEE;
}

/** True when the owner has configured no hold at all, which is a supported choice. */
export function withdrawalHoldDisabled(policy: WithdrawalPolicy): boolean {
  return policy.newAddressWindowMinutes === 0;
}

/** The window in words, for the panel and the job list. */
export function formatWithdrawalWindow(minutes: number): string {
  if (minutes === 0) return "no hold: a first withdrawal to a new address sends immediately";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  if (minutes % 1_440 === 0) {
    const days = minutes / 1_440;
    return `${days} day${days === 1 ? "" : "s"}`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  return `${minutes} minutes`;
}
