import { prisma } from "@/lib/db";
import { getIntegrationFeatureSettings } from "@/lib/integrations/settings";
import { orderVenue, PAPER_VENUE_ID, type OrderVenuePort } from "@/lib/orders/venue";
import { getLiveExecutionSetting } from "@/lib/risk-controls/settings";
import {
  decryptVenueCredentials,
  type TradingVenue,
  type VenueCredentialMaterial,
} from "@/lib/trading/credential-vault";
import { getWunderTradingFeatureSettings } from "@/lib/wundertrading/settings";
import { usdtPairFor } from "./binance-shared";
import { createCcxtVenue, type CcxtVenueOptions } from "./ccxt-adapter";
import { createLiveVenue } from "./live-adapter";
import { createTestnetVenue } from "./testnet-adapter";
import { createWunderTradingVenue } from "./wundertrading-adapter";
import {
  isLiveOrderVenueId,
  isTestnetVenueId,
  isVenueId,
  LIVE_ORDER_VENUE_IDS,
  TESTNET_VENUE_IDS,
  VENUE_DESCRIPTORS,
  type VenueAdapter,
  type VenueId,
  type VenueSecret,
} from "./types";

/**
 * The one place a venue is chosen.
 *
 * A caller holds a venue id from a credential row and calls {@link createVenue}; it
 * gets back an adapter that speaks the interface in `types.ts`. This function is the
 * *only* switch over venue names in the build, which is the property the phases ask
 * for: adding a venue is an adapter and a descriptor, not an `if` in a route.
 *
 * `venueAccessRefusal` is the other half of the same idea. WunderTrading's reads are
 * switched off by an owner-controlled setting in Access & Integrations; that policy
 * belongs beside the choice of adapter rather than in the route, so the route asks
 * "may this venue be used?" once and never learns which name it is asking about.
 *
 * Phase 22 adds the third routing answer. Where an order goes is now:
 *
 *   live   — the owner's switch in /admin/risk is on, and the account has a live key
 *   testnet — the testnet switch is on, and the account has a testnet key
 *   paper  — neither, which is the default and moves no money
 *
 * The live switch is checked **here**, once, and nowhere else: a request that names live
 * while the switch is off is refused before an order row exists, and the route audits
 * that refusal with the switch's state. An order that is already open is resolved by
 * {@link resolveVenueForOrder} from its *own* recorded venue, so turning the switch off
 * mid-flight lets it finish or reconcile instead of stranding it.
 */

export type VenueAccessRefusal = { status: number; error: string };

export type CreateVenueOptions = {
  /** Test seam: the same adapter code driven by a counting fake transport. */
  ccxt?: CcxtVenueOptions;
};

export function createVenue(
  id: VenueId,
  credentials: VenueCredentialMaterial,
  options: CreateVenueOptions = {},
): VenueAdapter {
  if (id === "wundertrading") {
    return createWunderTradingVenue(credentials);
  }
  if (id === "binance-testnet") {
    return createTestnetVenue(credentials);
  }
  return createCcxtVenue(id, credentials, options.ccxt);
}

export const TESTNET_CREDENTIAL_MISSING = "TESTNET_CREDENTIAL_MISSING";
export const TESTNET_CREDENTIAL_UNREADABLE = "TESTNET_CREDENTIAL_UNREADABLE";
export const TESTNET_ROUTING_DISABLED = "TESTNET_ROUTING_DISABLED";
export const LIVE_CREDENTIAL_MISSING = "LIVE_CREDENTIAL_MISSING";
export const LIVE_CREDENTIAL_UNREADABLE = "LIVE_CREDENTIAL_UNREADABLE";
export const LIVE_EXECUTION_DISABLED = "LIVE_EXECUTION_DISABLED";
export const UNKNOWN_ORDER_VENUE = "UNKNOWN_ORDER_VENUE";

/** The switches that decide where an order goes, read together. */
export type OrderRoutingSettings = {
  testnetOrdersEnabled: boolean;
  liveExecutionEnabled: boolean;
};

/**
 * The switches, from the rows their panels edit.
 *
 * `testnetOrdersEnabled` is integration data (phase 21); `liveExecutionEnabled` is risk
 * data (phase 22) because it is beside the limits and the kill switch, and because a
 * person changing it is making a statement about money. Both default off.
 *
 * A row that cannot be read is an error, not "off": the caller turns it into a refusal,
 * because a switch nobody could read is not permission to place anything.
 */
export async function readOrderRoutingSettings(): Promise<OrderRoutingSettings> {
  const [integrations, live] = await Promise.all([
    getIntegrationFeatureSettings(),
    getLiveExecutionSetting(),
  ]);
  return {
    testnetOrdersEnabled: integrations.testnetOrdersEnabled === true,
    liveExecutionEnabled: live.enabled === true,
  };
}

export type OrderVenueCredentialSummary = {
  id: string;
  label: string;
  venue: string;
  verifiedAt: string | null;
  lastCheckError: string | null;
};

export type OrderVenueResolution =
  | {
      kind: "resolved";
      venue: OrderVenuePort;
      source: "paper" | "testnet" | "live";
      detail: string;
      /** Present when an account key backs the order; the pre-trade report reads it. */
      credential?: OrderVenueCredentialSummary;
    }
  | { kind: "refused"; status: number; code: string; error: string };

export type VenueCredentialRow = {
  id: string;
  venue: string;
  label: string;
  readOnly: boolean;
  credentialCiphertext: string;
  credentialIv: string;
  credentialAuthTag: string;
  createdAt: Date;
  verifiedAt?: Date | null;
  lastCheckError?: string | null;
};

/** Kept for the phase-21 tests and callers that already name the type. */
export type TestnetCredentialRow = VenueCredentialRow;

/**
 * Which of an account's keys backs orders.
 *
 * The newest **trade-capable** key, and only when there is none, the newest key of any scope —
 * because "the key is read-only" is a sentence the owner can act on, while "no key" would be
 * untrue. Derived in one pure function so the rule is asserted without a database.
 */
export function pickTestnetCredential(rows: readonly VenueCredentialRow[]): VenueCredentialRow | null {
  if (rows.length === 0) return null;
  const tradeCapable = rows.filter((row) => !row.readOnly);
  const pool = tradeCapable.length > 0 ? tradeCapable : rows;
  return [...pool].sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0] ?? null;
}

export type RequestedExecution = "paper" | "testnet" | "live";

export type OrderVenueDeps = {
  /** Defaults read the two admin rows. */
  settings?: () => Promise<OrderRoutingSettings>;
  /** What the request asked for; omitted means "wherever routing currently points". */
  requested?: RequestedExecution;
  /** Defaults to the account's newest unrevoked key for the requested venue. */
  credential?: (userId: string) => Promise<VenueCredentialRow | null>;
  liveCredential?: (userId: string) => Promise<VenueCredentialRow | null>;
  decrypt?: typeof decryptVenueCredentials;
  createTestnet?: (secret: VenueSecret) => OrderVenuePort;
  createLive?: (secret: VenueSecret) => OrderVenuePort;
  paper?: () => OrderVenuePort;
};

/**
 * Why this venue may not place an order, or null when it may.
 *
 * The paper venue is always allowed (it moves nothing). A testnet is allowed because its
 * descriptor says it may place. A live venue is allowed only when its descriptor publishes
 * `place` **and** the owner's switch is on; the refusal names the switch, its state and the
 * panel that edits it, because that is the thing the owner can change.
 *
 * This is not an approval gate in front of a live order: when the switch is on there is no
 * further question, and when it is off the live venue is simply not selected. The one
 * boolean the owner sets is the whole authorisation.
 */
export function orderPlacementRefusal(
  id: string,
  settings: Pick<OrderRoutingSettings, "liveExecutionEnabled"> = { liveExecutionEnabled: false },
): string | null {
  if (id === PAPER_VENUE_ID) return null;
  if (!isVenueId(id)) return `${id} is not a venue this build knows, so it cannot be sent an order.`;
  const descriptor = VENUE_DESCRIPTORS[id];
  if (!descriptor.capabilities.includes("place")) {
    return (
      `${descriptor.label} does not publish order placement through this connection, so it cannot be sent an order. ` +
      "Its descriptor lists only the capabilities it implements."
    );
  }
  if (descriptor.environment === "testnet") return null;
  if (descriptor.environment === "live" && settings.liveExecutionEnabled) return null;
  return (
    `Live execution is switched off: the owner's switch in /admin/risk (liveExecutionEnabled) is off. ` +
    `No order was sent to ${descriptor.label}. Turn the switch on there to place a real-money order, ` +
    "or leave it off and orders route to the testnet or paper venue."
  );
}

async function defaultCredentialFor(userId: string, venueIds: readonly string[]): Promise<VenueCredentialRow | null> {
  const rows = await prisma.tradingVenueCredential.findMany({
    where: { userId, venue: { in: [...venueIds] }, revokedAt: null },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      venue: true,
      label: true,
      readOnly: true,
      credentialCiphertext: true,
      credentialIv: true,
      credentialAuthTag: true,
      createdAt: true,
      verifiedAt: true,
      lastCheckError: true,
    },
  });
  return pickTestnetCredential(rows);
}

function defaultTestnetCredential(userId: string): Promise<VenueCredentialRow | null> {
  return defaultCredentialFor(userId, TESTNET_VENUE_IDS);
}

function credentialSummary(row: VenueCredentialRow): OrderVenueCredentialSummary {
  return {
    id: row.id,
    label: row.label,
    venue: row.venue,
    verifiedAt: row.verifiedAt ? new Date(row.verifiedAt).toISOString() : null,
    lastCheckError: row.lastCheckError ?? null,
  };
}

function paperResolution(detail?: string): OrderVenueResolution {
  return {
    kind: "resolved",
    venue: orderVenue(),
    source: "paper",
    detail:
      detail ??
      "Orders go to the development paper venue: no exchange is contacted and no real funds move.",
  };
}

type CredentialVenueInput = {
  userId: string;
  /** The exact venue the order must go to, or null to take the newest key of the set. */
  venueId: string | null;
  venueIds: readonly string[];
  credential?: (userId: string) => Promise<VenueCredentialRow | null>;
  decrypt: typeof decryptVenueCredentials;
  create: (secret: VenueSecret) => OrderVenuePort;
  settings: OrderRoutingSettings;
  source: "testnet" | "live";
  /**
   * True when resolving a venue that already holds the order (reconciliation, cancel).
   * Placement is governed by the switch; asking an existing order's venue is not, so the
   * switch must not turn a live order's reconciliation into a refusal.
   */
  permitLivePlacement?: boolean;
};

/**
 * Turn one credential row into a venue port, or into the refusal that says why not.
 *
 * Shared by submission and by per-order resolution so the two cannot disagree about
 * which key backs an order, what a read-only key means, or how an unreadable ciphertext
 * is reported. The only difference is the sentence naming the source.
 */
async function resolveCredentialVenue(input: CredentialVenueInput): Promise<OrderVenueResolution> {
  const live = input.source === "live";
  const missingCode = live ? LIVE_CREDENTIAL_MISSING : TESTNET_CREDENTIAL_MISSING;
  const unreadableCode = live ? LIVE_CREDENTIAL_UNREADABLE : TESTNET_CREDENTIAL_UNREADABLE;
  const switchName = live ? "liveExecutionEnabled in /admin/risk" : "testnetOrdersEnabled in Access & Integrations";

  let row: VenueCredentialRow | null;
  try {
    row =
      input.venueId !== null
        ? input.credential
          ? await input.credential(input.userId)
          : await defaultCredentialFor(input.userId, [input.venueId])
        : await (input.credential ?? ((id: string) => defaultCredentialFor(id, input.venueIds)))(input.userId);
  } catch {
    return {
      kind: "refused",
      status: 503,
      code: "DATABASE_UNAVAILABLE",
      error: `The account's ${live ? "live" : "testnet"} key could not be read, so no order was sent.`,
    };
  }

  if (!row) {
    return {
      kind: "refused",
      status: 409,
      code: missingCode,
      error: live
        ? "Live execution is switched on, but this account has no Binance key. Connect a key created for trading in " +
          "Access & Integrations, or switch live execution off to place paper or testnet orders."
        : "Testnet order routing is switched on, but this account has no Binance Spot Testnet key. " +
          "Connect one in Access & Integrations, or switch testnet routing off to place paper orders.",
    };
  }
  if (!isVenueId(row.venue)) {
    return {
      kind: "refused",
      status: 409,
      code: missingCode,
      error: `The key "${row.label}" is not a venue this build knows, so it cannot back an order.`,
    };
  }
  if (live ? !isLiveOrderVenueId(row.venue) : !isTestnetVenueId(row.venue)) {
    return {
      kind: "refused",
      status: 409,
      code: missingCode,
      error: `The key "${row.label}" belongs to ${VENUE_DESCRIPTORS[row.venue].label}, which is not a ${live ? "live" : "testnet"} venue this build can place on.`,
    };
  }
  if (row.readOnly) {
    return {
      kind: "refused",
      status: 409,
      code: "READ_ONLY_CREDENTIAL",
      error:
        `The ${VENUE_DESCRIPTORS[row.venue].label} key "${row.label}" is stored as read-only, so it cannot place an order. ` +
        `Connect a key created for trading, or switch ${switchName} off.`,
    };
  }

  let material: VenueCredentialMaterial;
  try {
    material = input.decrypt(row.venue as TradingVenue, {
      ciphertext: row.credentialCiphertext,
      iv: row.credentialIv,
      authTag: row.credentialAuthTag,
      fingerprint: "",
    });
  } catch {
    return {
      kind: "refused",
      status: 503,
      code: unreadableCode,
      error: `The stored key "${row.label}" could not be read, so no order was sent. Connect the key again to replace it.`,
    };
  }

  const venue = input.create(material);
  const refusal = orderPlacementRefusal(venue.id, {
    liveExecutionEnabled: input.permitLivePlacement === true || input.settings.liveExecutionEnabled,
  });
  if (refusal) {
    return {
      kind: "refused",
      status: 403,
      code: live ? LIVE_EXECUTION_DISABLED : "VENUE_MAY_NOT_PLACE",
      error: refusal,
    };
  }

  return {
    kind: "resolved",
    venue,
    source: input.source,
    detail: live
      ? `Orders go to ${VENUE_DESCRIPTORS[row.venue].label} with the key "${row.label}", and real funds can move. ` +
        "The owner's switch is on; there is no further prompt."
      : `Orders go to ${VENUE_DESCRIPTORS[row.venue].label} with the key "${row.label}". ` +
        "Its sandbox endpoint only: the client is refused if it resolves to any other host, and no real funds can move.",
    credential: credentialSummary(row),
  };
}

/**
 * The venue an account's orders will be placed on, or a refusal that says why not.
 *
 * The request may ask for a specific environment (the trading page's selector, and the
 * acceptance test for "live with the switch off"). Omitted, routing decides: live when the
 * owner's switch is on, then testnet when that switch is on, then paper.
 */
export async function resolveOrderVenue(userId: string, deps: OrderVenueDeps = {}): Promise<OrderVenueResolution> {
  let settings: OrderRoutingSettings;
  try {
    settings = await (deps.settings ?? readOrderRoutingSettings)();
  } catch {
    return {
      kind: "refused",
      status: 503,
      code: "DATABASE_UNAVAILABLE",
      error:
        "Order routing settings could not be read, so no order was sent. An unreadable switch is not permission to place one.",
    };
  }

  const requested = deps.requested ?? null;
  if (requested === "live" && !settings.liveExecutionEnabled) {
    return {
      kind: "refused",
      status: 403,
      code: LIVE_EXECUTION_DISABLED,
      error:
        "Live execution is switched off: the owner's switch in /admin/risk (liveExecutionEnabled) is off, " +
        "so this live order was not sent to a venue. Nothing was reserved, recorded or sent.",
    };
  }
  if (requested === "testnet" && !settings.testnetOrdersEnabled) {
    return {
      kind: "refused",
      status: 409,
      code: TESTNET_ROUTING_DISABLED,
      error:
        "Testnet order routing is switched off in Access & Integrations (testnetOrdersEnabled), " +
        "so this testnet order was not sent to a venue.",
    };
  }

  const route: "paper" | "testnet" | "live" =
    requested === "paper"
      ? "paper"
      : requested === "testnet"
        ? "testnet"
        : requested === "live"
          ? "live"
          : settings.liveExecutionEnabled
            ? "live"
            : settings.testnetOrdersEnabled
              ? "testnet"
              : "paper";

  if (route === "paper") {
    return paperResolution(
      settings.liveExecutionEnabled
        ? "The request asked for the paper venue, which moves no money."
        : settings.testnetOrdersEnabled
          ? "The request asked for the paper venue, which moves no money; testnet routing is also on."
          : "Live execution and testnet routing are both switched off (liveExecutionEnabled in /admin/risk, " +
              "testnetOrdersEnabled in Access & Integrations), so orders go to the development paper venue. " +
              "No exchange is contacted and no real funds move.",
    );
  }

  const credentialProvider = route === "live" ? deps.liveCredential : deps.credential;
  return resolveCredentialVenue({
    userId,
    venueId: null,
    venueIds: route === "live" ? LIVE_ORDER_VENUE_IDS : TESTNET_VENUE_IDS,
    ...(credentialProvider ? { credential: credentialProvider } : {}),
    decrypt: deps.decrypt ?? decryptVenueCredentials,
    create:
      route === "live"
        ? (deps.createLive ?? ((secret: VenueSecret) => createLiveVenue(secret)))
        : (deps.createTestnet ?? ((secret: VenueSecret) => createTestnetVenue(secret))),
    settings,
    source: route,
  });
}

export type OrderVenueForOrderDeps = {
  settings?: () => Promise<OrderRoutingSettings>;
  decrypt?: typeof decryptVenueCredentials;
  createTestnet?: (secret: VenueSecret) => OrderVenuePort;
  createLive?: (secret: VenueSecret) => OrderVenuePort;
  paper?: () => OrderVenuePort;
  /** Defaults to the newest unrevoked key for the order's venue. */
  credential?: (userId: string, venueId: string) => Promise<VenueCredentialRow | null>;
};

/**
 * The venue an **existing** order went to, decided from the order's own row.
 *
 * This is the reconciliation and cancellation answer, and it deliberately ignores the
 * switches. Turning live execution off must not strand an order that is already live:
 * reconciliation still asks the venue that holds it, and a cancel still reaches it. What
 * the switch controls is *placement*, not the record of what was already placed.
 *
 * It is also narrower than submission: only the order's own venue is looked up, so a
 * paper order is never asked of the testnet, and an unknown venue is a sentence rather
 * than a guess.
 */
export async function resolveVenueForOrder(
  userId: string,
  venueId: string,
  deps: OrderVenueForOrderDeps = {},
): Promise<OrderVenueResolution> {
  if (venueId === PAPER_VENUE_ID) {
    return {
      kind: "resolved",
      venue: (deps.paper ?? orderVenue)(),
      source: "paper",
      detail: "The order is recorded on the development paper venue, which holds it and can be asked about it.",
    };
  }

  let settings: OrderRoutingSettings;
  try {
    settings = await (deps.settings ?? readOrderRoutingSettings)();
  } catch {
    settings = { testnetOrdersEnabled: false, liveExecutionEnabled: false };
  }

  if (isTestnetVenueId(venueId) || isLiveOrderVenueId(venueId)) {
    return resolveCredentialVenue({
      userId,
      venueId,
      venueIds: [venueId],
      ...(deps.credential ? { credential: (id: string) => deps.credential!(id, venueId) } : {}),
      decrypt: deps.decrypt ?? decryptVenueCredentials,
      create:
        isLiveOrderVenueId(venueId)
          ? (deps.createLive ?? ((secret: VenueSecret) => createLiveVenue(secret)))
          : (deps.createTestnet ?? ((secret: VenueSecret) => createTestnetVenue(secret))),
      settings,
      source: isLiveOrderVenueId(venueId) ? "live" : "testnet",
      permitLivePlacement: true,
    });
  }

  return {
    kind: "refused",
    status: 409,
    code: UNKNOWN_ORDER_VENUE,
    error: `The order names ${venueId}, which is not a venue this build knows, so it cannot be asked about the order.`,
  };
}

export type OrderVenueSummary = {
  environment: "paper" | "testnet" | "live";
  venueId: string;
  label: string;
  testnetRoutingEnabled: boolean;
  liveExecutionEnabled: boolean;
  available: boolean;
  detail: string;
};

/**
 * What the surfaces say about order routing, without a user or a key.
 *
 * The status endpoint, the order list and both pages need to answer "where would an order
 * go?" before anyone submits one. That answer depends on the switches only — the key is
 * per account and is decided at submission — so this reads them and says so, including
 * when a switch itself cannot be read.
 */
export async function orderVenueSummary(
  deps: { settings?: () => Promise<OrderRoutingSettings> } = {},
): Promise<OrderVenueSummary> {
  try {
    const settings = await (deps.settings ?? readOrderRoutingSettings)();
    if (settings.liveExecutionEnabled) {
      return {
        environment: "live",
        venueId: "binance",
        label: VENUE_DESCRIPTORS.binance.label,
        testnetRoutingEnabled: settings.testnetOrdersEnabled,
        liveExecutionEnabled: true,
        available: true,
        detail:
          "Live execution is switched on in /admin/risk: orders are sent to Binance with the signed-in account's own " +
          "key, and real funds move. The switch is the only authorisation; there is no further prompt.",
      };
    }
    if (settings.testnetOrdersEnabled) {
      return {
        environment: "testnet",
        venueId: "binance-testnet",
        label: VENUE_DESCRIPTORS["binance-testnet"].label,
        testnetRoutingEnabled: true,
        liveExecutionEnabled: false,
        available: true,
        detail:
          "Orders are placed on Binance Spot Testnet with the signed-in account's own testnet key, so no real funds " +
          "can move. Live execution is switched off in /admin/risk, and the sandbox is the only endpoint this route reaches.",
      };
    }
    return {
      environment: "paper",
      venueId: PAPER_VENUE_ID,
      label: "Development paper venue",
      testnetRoutingEnabled: false,
      liveExecutionEnabled: false,
      available: true,
      detail:
        "Orders go to the development paper venue. No exchange is contacted and no real funds move. " +
        "Switch testnet routing on in Access & Integrations, or live execution in /admin/risk, to place elsewhere.",
    };
  } catch {
    return {
      environment: "paper",
      venueId: PAPER_VENUE_ID,
      label: "Development paper venue",
      testnetRoutingEnabled: false,
      liveExecutionEnabled: false,
      available: false,
      detail:
        "Order routing settings could not be read, so a submission would be refused rather than sent anywhere. " +
        "The development paper venue is shown because nothing else can be selected, and no real funds move on it.",
    };
  }
}

export type TestnetComparison = {
  market: string;
  mappedPair: string | null;
  liveExecutionEnabled: boolean;
  testnetRoutingEnabled: boolean;
  testnetKeyLabel: string | null;
  testnetKeyReadOnly: boolean | null;
  wouldPlaceOnTestnet: boolean;
  detail: string;
};

/**
 * The same order, evaluated against the testnet configuration — a report, not a step.
 *
 * It reads the two switches and whether a testnet key exists, maps the market and says
 * what the testnet would have been asked. It decrypts nothing, contacts nothing and
 * places nothing, and the live path never calls it: the surface asks for it separately so
 * the owner can compare the two before or after a live order without the comparison
 * standing between them and the exchange.
 */
export async function describeTestnetComparison(
  userId: string,
  market: string,
  deps: {
    settings?: () => Promise<OrderRoutingSettings>;
    credential?: (userId: string) => Promise<VenueCredentialRow | null>;
  } = {},
): Promise<TestnetComparison> {
  const settings = await (deps.settings ?? readOrderRoutingSettings)().catch(() => ({
    testnetOrdersEnabled: false,
    liveExecutionEnabled: false,
  }));
  const row = await (deps.credential ?? defaultTestnetCredential)(userId).catch(() => null);
  const mappedPair = usdtPairFor(market);
  const wouldPlaceOnTestnet = mappedPair !== null && row !== null && !row.readOnly;
  return {
    market,
    mappedPair,
    liveExecutionEnabled: settings.liveExecutionEnabled,
    testnetRoutingEnabled: settings.testnetOrdersEnabled,
    testnetKeyLabel: row?.label ?? null,
    testnetKeyReadOnly: row ? row.readOnly : null,
    wouldPlaceOnTestnet,
    detail:
      mappedPair === null
        ? `${market} does not map onto a Binance USDT pair, so the testnet could not be asked this order either.`
        : row === null
          ? `The same order would be sent to the testnet as ${mappedPair}, but this account has no testnet key, so it would be refused there.`
          : row.readOnly
            ? `The same order would be sent to the testnet as ${mappedPair}, but the testnet key "${row.label}" is read-only, so it would be refused there.`
            : `The same order would be sent to the testnet as ${mappedPair} with the key "${row.label}". ` +
              `Testnet routing is ${settings.testnetOrdersEnabled ? "on" : "off"}, and this report places nothing.`,
  };
}

/**
 * Whether this deployment currently allows the venue at all.
 *
 * Today only WunderTrading has an owner switch of this kind, and it is read from the same
 * settings row its dedicated page and route read. A settings table that cannot be read is
 * a 503 rather than an allow: "we could not check the switch" is not permission.
 */
export async function venueAccessRefusal(id: VenueId): Promise<VenueAccessRefusal | null> {
  if (id !== "wundertrading") return null;

  const settings = await getWunderTradingFeatureSettings().catch(() => null);
  if (!settings) {
    return { status: 503, error: "WunderTrading settings are unavailable." };
  }
  if (!settings.apiProfilesEnabled) {
    return {
      status: 403,
      error: "WunderTrading profile access is switched off in Access & Integrations.",
    };
  }
  return null;
}
