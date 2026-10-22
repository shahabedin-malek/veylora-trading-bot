import { reason, type Reason } from "@/lib/observability/reason";
import { rpcConfigurationVariableName, resolveRpcEndpoint } from "@/lib/rpc/networks";
import {
  DEFAULT_ENABLED_DEPOSIT_NETWORKS,
  DEPOSIT_NETWORKS,
  getDepositNetwork,
  isDepositNetworkSlug,
  type DepositNetworkDefault,
} from "./registry";

/**
 * The deposit policy the owner edits, as data.
 *
 * Everything an owner decides about deposits is a named value in the
 * environment, resolved in one place so no surface invents its own default:
 *
 *   DEPOSIT_ADDRESS_MNEMONIC      the BIP-39 seed every deposit address derives from
 *   DEPOSIT_ENABLED_NETWORKS      which chains we accept deposits on
 *   DEPOSIT_CONFIRMATIONS_<SLUG>  how many confirmations before crediting, per chain
 *   DEPOSIT_MIN_AMOUNT_<SLUG>     the dust guard, per chain
 *   DEPOSIT_TOKEN_ADDRESS_<SLUG>  the deposit token's contract (required on a testnet)
 *   DEPOSIT_TOKEN_DECIMALS_<SLUG> that token's decimals
 *   DEPOSIT_TOKEN_SYMBOL_<SLUG>   the ticker shown to the owner
 *   DEPOSIT_WATCH_BLOCKS          how many blocks one run scans at most
 *   DEPOSIT_SCAN_UNFILTERED       also record arrivals addressed to *other* addresses
 *
 * The `<SLUG>` form uppercases the slug and replaces dashes with underscores:
 * `ethereum-mainnet` → `DEPOSIT_CONFIRMATIONS_ETHEREUM_MAINNET`.
 *
 * A network that cannot work is never silently dropped. It keeps its row, its
 * status, and the **name of the variable** that would fix it — "missing
 * configuration" on its own would send the owner looking in the wrong place.
 */

export const DEPOSIT_SEED_VARIABLE = "DEPOSIT_ADDRESS_MNEMONIC";
export const DEPOSIT_ENABLED_NETWORKS_VARIABLE = "DEPOSIT_ENABLED_NETWORKS";
export const DEPOSIT_WATCH_INTERVAL_VARIABLE = "DEPOSIT_WATCH_INTERVAL_MINUTES";
export const DEPOSIT_WATCH_BLOCKS_VARIABLE = "DEPOSIT_WATCH_BLOCKS";
export const DEPOSIT_SCAN_UNFILTERED_VARIABLE = "DEPOSIT_SCAN_UNFILTERED";

/** One run scans at most this many blocks per network. */
export const DEFAULT_DEPOSIT_WATCH_BLOCKS = 250;
/** Minutes between watcher runs, before the owner's own number applies. */
export const DEFAULT_DEPOSIT_WATCH_INTERVAL_MINUTES = 5;
/** The dust guard before the owner's own per-network number applies. */
export const DEFAULT_DEPOSIT_MINIMUM_AMOUNT = "1";

export type DepositTokenPolicy = {
  symbol: string;
  displayName: string;
  address: string;
  decimals: number;
  note?: string;
};

export type DepositNetworkStatus = "ready" | "disabled" | "missing-rpc" | "missing-token" | "invalid-config";

export type DepositNetworkPolicy = {
  slug: string;
  chainId: number;
  alchemyNetwork: string;
  displayName: string;
  nativeSymbol: string;
  testnet: boolean;
  enabled: boolean;
  status: DepositNetworkStatus;
  /** The variable names that would make this network ready, in the order to set them. */
  missing: string[];
  /** What is wrong with a value that *is* set (an unparseable number, a bad address). */
  problems: string[];
  token: DepositTokenPolicy | null;
  confirmations: number;
  minimumAmount: string;
  /** Where the numbers came from, so the owner can see they are defaults or their own. */
  configuredBy: { confirmations: boolean; minimumAmount: boolean; token: boolean };
};

export type DepositPolicy = {
  /** The BIP-39 mnemonic, or null when it is not configured. */
  mnemonic: string | null;
  networks: DepositNetworkPolicy[];
  /** Only the networks a run may touch. */
  enabledNetworks: DepositNetworkPolicy[];
  watchIntervalMinutes: number;
  watchBlocks: number;
  scanUnfiltered: boolean;
  /**
   * Problems with the *list*, as opposed to with one network's values: today,
   * slugs `DEPOSIT_ENABLED_NETWORKS` names that are not networks this build
   * knows. They are stated once, here, rather than repeated on every row — and
   * never silently dropped, because a typo in that variable would otherwise look
   * exactly like a deployment that only meant to enable what it typed.
   */
  problems: string[];
};

export function depositEnvKey(prefix: string, slug: string): string {
  return `${prefix}_${slug.toUpperCase().replace(/-/g, "_")}`;
}

function hasRealValue(value: string | undefined): value is string {
  const trimmed = value?.trim();
  return Boolean(trimmed && !/^(?:replace|change.?me|example|your.?)/i.test(trimmed));
}

function readPositiveInteger(value: string | undefined, fallback: number, minimum = 1): number {
  if (!hasRealValue(value)) return fallback;
  const parsed = Number(value.trim());
  if (!Number.isSafeInteger(parsed) || parsed < minimum) return fallback;
  return parsed;
}

function isDecimal(value: string): boolean {
  return /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value);
}

function isBooleanFlag(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes((value ?? "").trim().toLowerCase());
}

/**
 * The slugs `DEPOSIT_ENABLED_NETWORKS` names, split into the ones this build can
 * act on and the ones it cannot.
 *
 * A slug that *looks* right but is not in the registry (`dogecoin`) is reported
 * exactly like a malformed one. It would be easy to let it pass silently — the
 * shape check does — and that silence is the failure: an owner who mistyped a
 * network would see a deposits page that simply has one chain missing, with
 * nothing anywhere saying why.
 */
function enabledSlugs(env: NodeJS.ProcessEnv): { slugs: string[]; invalid: string[] } {
  const raw = env[DEPOSIT_ENABLED_NETWORKS_VARIABLE];
  if (!hasRealValue(raw)) return { slugs: [...DEFAULT_ENABLED_DEPOSIT_NETWORKS], invalid: [] };
  const slugs: string[] = [];
  const invalid: string[] = [];
  for (const part of raw.split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean)) {
    if (!isDepositNetworkSlug(part) || !getDepositNetwork(part)) {
      invalid.push(part);
      continue;
    }
    if (!slugs.includes(part)) slugs.push(part);
  }
  return { slugs, invalid };
}

function tokenFor(network: DepositNetworkDefault, env: NodeJS.ProcessEnv): {
  token: DepositTokenPolicy | null;
  missing: string[];
  problems: string[];
  configured: boolean;
} {
  const addressVariable = depositEnvKey("DEPOSIT_TOKEN_ADDRESS", network.slug);
  const decimalsVariable = depositEnvKey("DEPOSIT_TOKEN_DECIMALS", network.slug);
  const symbolVariable = depositEnvKey("DEPOSIT_TOKEN_SYMBOL", network.slug);
  const address = env[addressVariable];
  const decimals = env[decimalsVariable];
  const symbol = env[symbolVariable];
  const overridden = hasRealValue(address) || hasRealValue(decimals) || hasRealValue(symbol);

  if (!overridden && network.token) {
    return { token: { ...network.token }, missing: [], problems: [], configured: false };
  }

  const missing: string[] = [];
  const problems: string[] = [];
  const addressValue = hasRealValue(address) ? address.trim() : null;
  const decimalsValue = hasRealValue(decimals) ? decimals.trim() : null;
  if (addressValue === null) missing.push(addressVariable);
  else if (!/^0x[0-9a-fA-F]{40}$/.test(addressValue)) problems.push(`${addressVariable} is not a 20-byte hex address.`);
  if (decimalsValue === null) missing.push(decimalsVariable);
  else {
    const parsed = Number(decimalsValue);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 36) problems.push(`${decimalsVariable} must be a whole number from 0 to 36.`);
  }

  if (missing.length > 0 || problems.length > 0 || addressValue === null || decimalsValue === null) {
    // A network the owner pointed at a token for, but did not finish configuring.
    // The registry's own token is *not* used as a silent fallback: the owner said
    // this chain's token is something else, and crediting the wrong contract
    // would be worse than showing a gap.
    return { token: null, missing, problems, configured: true };
  }

  // Past the return above, both values are present and well formed.
  const symbolValue = hasRealValue(symbol) ? symbol.trim() : getDepositNetwork(network.slug)?.token?.symbol ?? "USDT";
  return {
    token: {
      symbol: symbolValue,
      displayName: hasRealValue(symbol) ? symbolValue : `${network.displayName} deposit token`,
      address: addressValue,
      decimals: Number(decimalsValue),
    },
    missing: [],
    problems: [],
    configured: true,
  };
}

/**
 * Resolve the whole policy. Pure: it reads only the environment it is handed, so
 * every status below is testable without a chain, a database or a deployment.
 */
export function readDepositPolicy(env: NodeJS.ProcessEnv = process.env): DepositPolicy {
  const { slugs, invalid } = enabledSlugs(env);

  const networks = DEPOSIT_NETWORKS.map<DepositNetworkPolicy>((network) => {
    const enabled = slugs.includes(network.slug);
    const missing: string[] = [];
    const problems: string[] = [];
    const confirmationsVariable = depositEnvKey("DEPOSIT_CONFIRMATIONS", network.slug);
    const minimumVariable = depositEnvKey("DEPOSIT_MIN_AMOUNT", network.slug);

    const confirmationsRaw = env[confirmationsVariable];
    const confirmationsConfigured = hasRealValue(confirmationsRaw);
    let confirmations = network.defaultConfirmations;
    if (confirmationsConfigured) {
      const parsed = Number(confirmationsRaw.trim());
      if (Number.isSafeInteger(parsed) && parsed >= 1) confirmations = parsed;
      else problems.push(`${confirmationsVariable} must be a whole number of at least 1.`);
    }

    const minimumRaw = env[minimumVariable];
    const minimumConfigured = hasRealValue(minimumRaw);
    let minimumAmount = DEFAULT_DEPOSIT_MINIMUM_AMOUNT;
    if (minimumConfigured) {
      if (isDecimal(minimumRaw.trim())) minimumAmount = minimumRaw.trim();
      else problems.push(`${minimumVariable} must be a decimal amount.`);
    }

    const token = tokenFor(network, env);
    missing.push(...token.missing);
    problems.push(...token.problems);

    const rpcVariable = rpcConfigurationVariableName(network.alchemyNetwork) ?? `ALCHEMY_${network.slug.toUpperCase().replace(/-/g, "_")}_RPC_URL`;
    if (enabled && !resolveRpcEndpoint(network.alchemyNetwork, env).ok) missing.push(rpcVariable);

    const status: DepositNetworkStatus = !enabled
      ? "disabled"
      : problems.length > 0
        ? "invalid-config"
        : missing.length > 0
          ? (missing.includes(rpcVariable) && token.token !== null ? "missing-rpc" : "missing-token")
          : "ready";

    return {
      slug: network.slug,
      chainId: network.chainId,
      alchemyNetwork: network.alchemyNetwork,
      displayName: network.displayName,
      nativeSymbol: network.nativeSymbol,
      testnet: network.testnet,
      enabled,
      status,
      missing,
      problems,
      token: token.token,
      confirmations,
      minimumAmount,
      configuredBy: {
        confirmations: confirmationsConfigured,
        minimumAmount: minimumConfigured,
        token: token.configured,
      },
    };
  });

  const mnemonic = hasRealValue(env[DEPOSIT_SEED_VARIABLE]) ? env[DEPOSIT_SEED_VARIABLE]!.trim() : null;

  return {
    mnemonic,
    networks,
    enabledNetworks: networks.filter((network) => network.enabled && network.status !== "disabled"),
    watchIntervalMinutes: readPositiveInteger(env[DEPOSIT_WATCH_INTERVAL_VARIABLE], DEFAULT_DEPOSIT_WATCH_INTERVAL_MINUTES),
    watchBlocks: readPositiveInteger(env[DEPOSIT_WATCH_BLOCKS_VARIABLE], DEFAULT_DEPOSIT_WATCH_BLOCKS, 1),
    scanUnfiltered: isBooleanFlag(env[DEPOSIT_SCAN_UNFILTERED_VARIABLE]),
    problems: invalid.map((slug) =>
      isDepositNetworkSlug(slug)
        ? `${DEPOSIT_ENABLED_NETWORKS_VARIABLE} lists "${slug}", which is not a deposit network this build knows, so it was not enabled.`
        : `${DEPOSIT_ENABLED_NETWORKS_VARIABLE} lists "${slug}", which is not a usable network slug, so it was not enabled.`,
    ),
  };
}

/**
 * Why deposits cannot be offered at all, or null when they can.
 *
 * One sentence naming the first variable to set, because a deployment without a
 * seed cannot derive an address and a network without a token cannot be watched;
 * both are configuration gaps, not failures of the chain.
 */
export function depositAvailabilityReason(policy: DepositPolicy): Reason | null {
  if (!policy.mnemonic) {
    return reason("MISSING_CONFIGURATION", {
      variable: DEPOSIT_SEED_VARIABLE,
      message: `${DEPOSIT_SEED_VARIABLE} is not configured, so no deposit address can be derived.`,
    });
  }
  if (policy.enabledNetworks.length === 0) {
    return reason("MISSING_CONFIGURATION", {
      variable: DEPOSIT_ENABLED_NETWORKS_VARIABLE,
      message:
        `No deposit network is enabled: set ${DEPOSIT_ENABLED_NETWORKS_VARIABLE} to a network slug list, and configure that network's token.` +
        (policy.problems.length > 0 ? ` ${policy.problems[0]}` : ""),
    });
  }
  return null;
}

/** The watcher's cadence in words, for the job list and the deposit panel. */
export function formatDepositInterval(minutes: number): string {
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

/** The policy row for one network, or null when the slug is not one we know. */
export function depositNetworkPolicy(slug: string, env: NodeJS.ProcessEnv = process.env): DepositNetworkPolicy | null {
  return readDepositPolicy(env).networks.find((network) => network.slug === slug) ?? null;
}
