import { decimalOf, userBalances, type AccountBalance } from "@/lib/ledger/accounts";
import {
  minorUnitsFromDecimalString,
  type LedgerPosting,
  type MinorUnits,
  type MoneyDirection,
} from "@/lib/ledger/integer-cent-ledger";
import { assetBalanceViews } from "@/lib/portfolio/pnl";

/**
 * The admin console's vocabulary, kept free of the database.
 *
 * Three things live here so they can be tested without a deployment:
 *
 *  - **The sections and their columns.** A section that exists is a row in
 *    {@link ADMIN_SECTIONS}; the navigation, the filter parser, the column
 *    chooser and the saved-view validator all read that list, so a section can
 *    never be offered by one surface and refused by another.
 *  - **Saved views.** Saving and restoring is a pure round trip over an
 *    injected persistence port; the Prisma adapter lives in `queries.ts`.
 *  - **The one mutating action's contract.** A correcting ledger entry is
 *    validated, its effect is stated in words before it runs, and its audit
 *    payload is built here, so a test can prove all three without a database.
 *
 * Balances are deliberately not computed here either: {@link adminBalanceRows}
 * calls the same `assetBalanceViews` the account page uses, which is what makes
 * "the console reconciles to `/account`" a property of one function rather than
 * a promise to keep two in step.
 */

export const ADMIN_SECTIONS = [
  "users",
  "wallets",
  "balances",
  "ledger",
  "deposits",
  "withdrawals",
  "orders",
  "strategies",
  "venue-keys",
  "fees",
  "limits",
  "switches",
  "audit",
] as const;

export type AdminSectionId = (typeof ADMIN_SECTIONS)[number];

export type AdminColumn = { key: string; label: string };

export type AdminFilterKind = "text" | "select" | "date";

export type AdminFilter = {
  key: string;
  label: string;
  kind: AdminFilterKind;
  placeholder?: string;
  options?: readonly string[];
};

export type AdminSectionConfig = {
  id: AdminSectionId;
  label: string;
  description: string;
  /** The record a row drills into, used by the detail panel and the timeline. */
  recordType: AdminRecordType;
  columns: readonly AdminColumn[];
  defaultColumns: readonly string[];
  filters: readonly AdminFilter[];
};

export type AdminRecordType =
  | "user"
  | "wallet"
  | "balance"
  | "ledger-entry"
  | "deposit"
  | "withdrawal"
  | "order"
  | "strategy"
  | "venue-key"
  | "fee"
  | "limit"
  | "switch"
  | "audit"
  | "ticket"
  | "session"
  | "delivery";

const STATUSES = {
  deposit: ["PENDING", "CONFIRMED", "CREDITED", "REVIEW", "REVERSED", "UNMATCHED"],
  withdrawal: ["REQUESTED", "HELD", "QUEUED", "BROADCAST", "CONFIRMED", "FAILED", "CANCELLED", "RELEASED"],
  order: ["CREATED", "SUBMITTED", "PARTIALLY_FILLED", "FILLED", "FAILED", "CANCELLED"],
  strategy: ["RUNNING", "STOPPED"],
} as const;

export const ADMIN_SECTIONS_CONFIG: readonly AdminSectionConfig[] = [
  {
    id: "users",
    label: "Users",
    description: "Every account, its role and when it was last seen.",
    recordType: "user",
    columns: [
      { key: "wallet", label: "Wallet" },
      { key: "role", label: "Role" },
      { key: "status", label: "Status" },
      { key: "lastSeenAt", label: "Last seen" },
      { key: "createdAt", label: "Created" },
      { key: "userId", label: "User id" },
    ],
    defaultColumns: ["wallet", "role", "status", "lastSeenAt", "createdAt"],
    filters: [
      { key: "q", label: "Search", kind: "text", placeholder: "Wallet, user id or role" },
      { key: "role", label: "Role", kind: "select", options: ["OWNER", "ADMIN", "TRADER", "VIEWER"] },
      { key: "status", label: "Status", kind: "select", options: ["ACTIVE", "SUSPENDED"] },
    ],
  },
  {
    id: "wallets",
    label: "Wallets",
    description: "Wallet identities and the account each one proves.",
    recordType: "wallet",
    columns: [
      { key: "address", label: "Address" },
      { key: "user", label: "User" },
      { key: "chain", label: "Chain" },
      { key: "accountType", label: "Account type" },
      { key: "verifiedAt", label: "Verified" },
    ],
    defaultColumns: ["address", "user", "chain", "accountType", "verifiedAt"],
    filters: [
      { key: "q", label: "Search", kind: "text", placeholder: "Address or user id" },
      { key: "chain", label: "Chain", kind: "text", placeholder: "eip155:1" },
      { key: "accountType", label: "Account type", kind: "select", options: ["EOA", "CONTRACT"] },
    ],
  },
  {
    id: "balances",
    label: "Balances",
    description: "Ledger-derived balances, per account and asset.",
    recordType: "balance",
    columns: [
      { key: "user", label: "User" },
      { key: "asset", label: "Asset" },
      { key: "available", label: "Available" },
      { key: "held", label: "Held" },
      { key: "total", label: "Total" },
      { key: "accounts", label: "Accounts" },
    ],
    defaultColumns: ["user", "asset", "available", "held", "total"],
    filters: [
      { key: "q", label: "Search", kind: "text", placeholder: "Wallet or user id" },
      { key: "asset", label: "Asset", kind: "text", placeholder: "USDT" },
    ],
  },
  {
    id: "ledger",
    label: "Ledger",
    description: "Every posted movement, with both sides of its transaction.",
    recordType: "ledger-entry",
    columns: [
      { key: "occurredAt", label: "Occurred" },
      { key: "user", label: "User" },
      { key: "kind", label: "Kind" },
      { key: "asset", label: "Asset" },
      { key: "amount", label: "Amount" },
      { key: "direction", label: "Direction" },
      { key: "account", label: "Account" },
      { key: "memo", label: "Memo" },
      { key: "transaction", label: "Transaction" },
    ],
    defaultColumns: ["occurredAt", "user", "kind", "asset", "amount", "direction", "account"],
    filters: [
      { key: "q", label: "Search", kind: "text", placeholder: "Wallet, transaction or account code" },
      { key: "asset", label: "Asset", kind: "text", placeholder: "USDT" },
      { key: "kind", label: "Kind", kind: "text", placeholder: "ADMIN_CORRECTION" },
      { key: "from", label: "From", kind: "date" },
      { key: "to", label: "To", kind: "date" },
    ],
  },
  {
    id: "deposits",
    label: "Deposits",
    description: "Chain arrivals the watcher recorded, credited or not.",
    recordType: "deposit",
    columns: [
      { key: "observedAt", label: "Observed" },
      { key: "user", label: "User" },
      { key: "network", label: "Network" },
      { key: "asset", label: "Asset" },
      { key: "amount", label: "Amount" },
      { key: "status", label: "Status" },
      { key: "confirmations", label: "Confirmations" },
      { key: "txHash", label: "Transaction" },
    ],
    defaultColumns: ["observedAt", "user", "network", "asset", "amount", "status", "txHash"],
    filters: [
      { key: "q", label: "Search", kind: "text", placeholder: "Hash, wallet or deposit id" },
      { key: "status", label: "Status", kind: "select", options: STATUSES.deposit },
      { key: "network", label: "Network", kind: "text", placeholder: "ethereum" },
    ],
  },
  {
    id: "withdrawals",
    label: "Withdrawals",
    description: "Every request from reservation to settlement.",
    recordType: "withdrawal",
    columns: [
      { key: "createdAt", label: "Created" },
      { key: "user", label: "User" },
      { key: "network", label: "Network" },
      { key: "asset", label: "Asset" },
      { key: "net", label: "Net" },
      { key: "fee", label: "Fee" },
      { key: "status", label: "Status" },
      { key: "txHash", label: "Transaction" },
    ],
    defaultColumns: ["createdAt", "user", "network", "asset", "net", "status", "txHash"],
    filters: [
      { key: "q", label: "Search", kind: "text", placeholder: "Hash, wallet or withdrawal id" },
      { key: "status", label: "Status", kind: "select", options: STATUSES.withdrawal },
      { key: "network", label: "Network", kind: "text", placeholder: "ethereum" },
    ],
  },
  {
    id: "orders",
    label: "Orders",
    description: "Paper and live intents, with the venue's own answer.",
    recordType: "order",
    columns: [
      { key: "createdAt", label: "Created" },
      { key: "user", label: "User" },
      { key: "venue", label: "Venue" },
      { key: "market", label: "Market" },
      { key: "side", label: "Side" },
      { key: "status", label: "Status" },
      { key: "notional", label: "Notional" },
      { key: "filled", label: "Filled" },
    ],
    defaultColumns: ["createdAt", "user", "venue", "market", "side", "status", "notional"],
    filters: [
      { key: "q", label: "Search", kind: "text", placeholder: "Order id, client id, wallet or market" },
      { key: "status", label: "Status", kind: "select", options: STATUSES.order },
      { key: "venue", label: "Venue", kind: "text", placeholder: "paper" },
    ],
  },
  {
    id: "strategies",
    label: "Strategies",
    description: "Each account's activation, its last pass and its switch.",
    recordType: "strategy",
    columns: [
      { key: "user", label: "User" },
      { key: "state", label: "State" },
      { key: "strategy", label: "Strategy" },
      { key: "lastEvaluatedAt", label: "Last pass" },
      { key: "runCount", label: "Passes" },
      { key: "outcome", label: "Outcome" },
      { key: "reason", label: "Reason" },
    ],
    defaultColumns: ["user", "state", "strategy", "lastEvaluatedAt", "runCount", "outcome"],
    filters: [
      { key: "q", label: "Search", kind: "text", placeholder: "Wallet or strategy id" },
      { key: "status", label: "State", kind: "select", options: STATUSES.strategy },
    ],
  },
  {
    id: "venue-keys",
    label: "Venue keys",
    description: "Connected exchange keys and what the venue last reported.",
    recordType: "venue-key",
    columns: [
      { key: "user", label: "User" },
      { key: "venue", label: "Venue" },
      { key: "label", label: "Label" },
      { key: "scope", label: "Scope" },
      { key: "verifiedAt", label: "Verified" },
      { key: "lastCheckedAt", label: "Checked" },
      { key: "problem", label: "Problem" },
    ],
    defaultColumns: ["user", "venue", "label", "scope", "verifiedAt", "problem"],
    filters: [
      { key: "q", label: "Search", kind: "text", placeholder: "Wallet, venue or label" },
      { key: "venue", label: "Venue", kind: "text", placeholder: "coinbase" },
    ],
  },
  {
    id: "fees",
    label: "Fees",
    description: "Each stored fee version, and the one in force.",
    recordType: "fee",
    columns: [
      { key: "effectiveFrom", label: "Effective from" },
      { key: "performanceFee", label: "Performance fee" },
      { key: "withdrawalFees", label: "Withdrawal fees" },
      { key: "tradingCosts", label: "Backtest costs" },
      { key: "createdAt", label: "Written" },
    ],
    defaultColumns: ["effectiveFrom", "performanceFee", "withdrawalFees", "createdAt"],
    filters: [{ key: "q", label: "Search", kind: "text", placeholder: "Version id" }],
  },
  {
    id: "limits",
    label: "Limits",
    description: "The global caps every order is checked against.",
    recordType: "limit",
    columns: [
      { key: "field", label: "Limit" },
      { key: "value", label: "Value" },
      { key: "unit", label: "Unit" },
      { key: "effectiveFrom", label: "Effective from" },
    ],
    defaultColumns: ["field", "value", "unit", "effectiveFrom"],
    filters: [{ key: "q", label: "Search", kind: "text", placeholder: "Limit name" }],
  },
  {
    id: "switches",
    label: "Switches",
    description: "The global and per-strategy stops, with who last moved each.",
    recordType: "switch",
    columns: [
      { key: "name", label: "Switch" },
      { key: "state", label: "State" },
      { key: "changedAt", label: "Changed" },
      { key: "changedBy", label: "By" },
      { key: "detail", label: "Detail" },
    ],
    defaultColumns: ["name", "state", "changedAt", "changedBy", "detail"],
    filters: [{ key: "q", label: "Search", kind: "text", placeholder: "Switch or account" }],
  },
  {
    id: "audit",
    label: "Audit",
    description: "Every recorded action, its actor and its outcome.",
    recordType: "audit",
    columns: [
      { key: "occurredAt", label: "Occurred" },
      { key: "actor", label: "Actor" },
      { key: "action", label: "Action" },
      { key: "objectType", label: "Object" },
      { key: "objectId", label: "Object id" },
      { key: "outcome", label: "Outcome" },
      { key: "payload", label: "Payload" },
    ],
    defaultColumns: ["occurredAt", "actor", "action", "objectType", "objectId", "outcome"],
    filters: [
      { key: "q", label: "Search", kind: "text", placeholder: "Actor, object id or action" },
      { key: "action", label: "Action", kind: "text", placeholder: "ADMIN_LEDGER_CORRECTION" },
      { key: "objectType", label: "Object type", kind: "text", placeholder: "LedgerTransaction" },
      { key: "from", label: "From", kind: "date" },
      { key: "to", label: "To", kind: "date" },
    ],
  },
] as const;

export function adminSection(id: unknown): AdminSectionConfig | null {
  return typeof id === "string" ? ADMIN_SECTIONS_CONFIG.find((section) => section.id === id) ?? null : null;
}

/** One row of one section, already reduced to the columns a person chose. */
export type AdminRow = {
  id: string;
  recordType: AdminRecordType;
  subjectUserId: string | null;
  cells: Record<string, string>;
  /** Values searched by `q` but never rendered as a column. */
  search: string[];
};

export function rowMatchesQuery(row: AdminRow, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const haystack = [row.id, ...Object.values(row.cells), ...row.search].join(" ").toLowerCase();
  return haystack.includes(needle);
}

export type AdminFilters = Record<string, string>;

const MAX_QUERY_LENGTH = 160;

function readDate(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) ? value : null;
}

/** Keep only the filters the section declares, normalised and bounded. */
export function normalizeAdminFilters(section: AdminSectionConfig, raw: Record<string, unknown>): AdminFilters {
  const filters: AdminFilters = {};
  for (const filter of section.filters) {
    const value = raw[filter.key];
    if (typeof value !== "string") continue;
    const trimmed = value.trim().slice(0, MAX_QUERY_LENGTH);
    if (!trimmed) continue;
    if (filter.kind === "date") {
      const date = readDate(trimmed);
      if (date) filters[filter.key] = date;
      continue;
    }
    // Symbols and actions are looked up exactly, so the box accepts lower case
    // and stores the spelling the database uses. A free-text id or hash is left
    // exactly as typed, because its case can be the thing being searched.
    const uppercase = filter.kind === "select" || filter.key === "asset" || filter.key === "kind" || filter.key === "action";
    filters[filter.key] = uppercase ? trimmed.toUpperCase() : trimmed;
  }
  return filters;
}

export type AdminColumns = string[];

export function normalizeAdminColumns(
  section: AdminSectionConfig,
  raw: unknown,
): { valid: true; columns: AdminColumns } | { valid: false; error: string } {
  if (raw === undefined || raw === null) {
    return { valid: true, columns: [...section.defaultColumns] };
  }
  const requested = (Array.isArray(raw) ? raw : String(raw).split(","))
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean);
  if (requested.length === 0) {
    return { valid: false, error: "Choose at least one column; an empty table would not be a view." };
  }
  const known = new Set(section.columns.map((column) => column.key));
  const unknown = requested.filter((column) => !known.has(column));
  if (unknown.length > 0) {
    return {
      valid: false,
      error: `${section.label} has no column ${unknown.map((column) => JSON.stringify(column)).join(", ")}. Available: ${section.columns
        .map((column) => column.key)
        .join(", ")}.`,
    };
  }
  // Keep the section's own order: a column choice changes which cells are
  // shown, not the table's reading order.
  return {
    valid: true,
    columns: section.columns.map((column) => column.key).filter((key) => requested.includes(key)),
  };
}

export type AdminConsoleQuery = {
  valid: true;
  section: AdminSectionConfig;
  filters: AdminFilters;
  columns: AdminColumns;
} | { valid: false; error: string };

export function parseAdminConsoleQuery(raw: Record<string, unknown>): AdminConsoleQuery {
  const section = adminSection(raw.section ?? "users");
  if (!section) {
    return { valid: false, error: `Unknown section ${JSON.stringify(raw.section)}. Sections: ${ADMIN_SECTIONS.join(", ")}.` };
  }
  const columns = normalizeAdminColumns(section, raw.columns);
  if (!columns.valid) return { valid: false, error: columns.error };
  return {
    valid: true,
    section,
    filters: normalizeAdminFilters(section, raw),
    columns: columns.columns,
  };
}

/** The same state as a URL query string, in a stable order. */
export function serializeAdminQuery(section: AdminSectionId, filters: AdminFilters, columns: readonly string[]): string {
  const params = new URLSearchParams();
  params.set("section", section);
  const config = adminSection(section);
  if (config) {
    for (const filter of config.filters) {
      const value = filters[filter.key];
      if (value) params.set(filter.key, value);
    }
  }
  if (columns.length > 0) params.set("columns", columns.join(","));
  return params.toString();
}

// ─────────────────────────────────────────────────────────────────────────────
// Saved views: persistence is a port, so the round trip is testable.
// ─────────────────────────────────────────────────────────────────────────────

export type SavedAdminView = {
  id: string;
  ownerUserId: string;
  name: string;
  section: AdminSectionId;
  filters: AdminFilters;
  columns: AdminColumns;
  createdAt: string;
  updatedAt: string;
};

export type SavedViewInput = {
  ownerUserId: string;
  name: unknown;
  section: unknown;
  filters: unknown;
  columns: unknown;
};

export type SavedViewPersistence = {
  list(ownerUserId: string): Promise<SavedAdminView[]>;
  upsert(input: {
    ownerUserId: string;
    name: string;
    section: AdminSectionId;
    filters: AdminFilters;
    columns: AdminColumns;
  }): Promise<SavedAdminView>;
  delete(ownerUserId: string, id: string): Promise<boolean>;
};

export type SavedViewResult =
  | { ok: true; view: SavedAdminView }
  | { ok: false; error: string };

const VIEW_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._/-]{0,59}$/u;

export async function saveAdminView(persistence: SavedViewPersistence, input: SavedViewInput): Promise<SavedViewResult> {
  const name = typeof input.name === "string" ? input.name.trim().replace(/\s+/g, " ") : "";
  if (!VIEW_NAME.test(name)) {
    return { ok: false, error: "A view name is 1–60 characters: letters, numbers, spaces, dots, dashes or underscores." };
  }
  const section = adminSection(input.section);
  if (!section) return { ok: false, error: `Unknown section ${JSON.stringify(input.section)}.` };
  const columns = normalizeAdminColumns(section, input.columns);
  if (!columns.valid) return { ok: false, error: columns.error };
  if (columns.columns.length === 0) return { ok: false, error: "Choose at least one column to save a view." };
  const filters = normalizeAdminFilters(section, isRecord(input.filters) ? input.filters : {});
  const view = await persistence.upsert({
    ownerUserId: input.ownerUserId,
    name,
    section: section.id,
    filters,
    columns: columns.columns,
  });
  return { ok: true, view };
}

export async function listAdminViews(
  persistence: SavedViewPersistence,
  ownerUserId: string,
  section?: AdminSectionId,
): Promise<SavedAdminView[]> {
  const views = await persistence.list(ownerUserId);
  return views
    .filter((view) => (section ? view.section === section : true))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function deleteAdminView(
  persistence: SavedViewPersistence,
  ownerUserId: string,
  id: unknown,
): Promise<{ deleted: boolean; error?: string }> {
  if (typeof id !== "string" || id.trim().length === 0) return { deleted: false, error: "A view id is required." };
  return { deleted: await persistence.delete(ownerUserId, id.trim()) };
}

/** The URL that restores a saved view exactly: its section, filters and columns. */
export function savedViewQuery(view: Pick<SavedAdminView, "section" | "filters" | "columns">): string {
  return serializeAdminQuery(view.section, view.filters, view.columns);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ─────────────────────────────────────────────────────────────────────────────
// Balances: the account page's own view, grouped by account.
// ─────────────────────────────────────────────────────────────────────────────

export type AdminBalanceRow = {
  userId: string;
  userLabel: string;
  asset: string;
  decimals: number;
  availableMinor: string;
  available: string;
  heldMinor: string;
  held: string;
  totalMinor: string;
  total: string;
  accounts: { code: string; bucket: string; balance: string; entries: number }[];
};

/**
 * One row per account and asset, built through `assetBalanceViews` — the exact
 * function `/account` renders. That is why the figures reconcile: the console
 * is not adding up a second set of numbers.
 */
export function adminBalanceRows(input: {
  userId: string;
  userLabel: string;
  balances: readonly AccountBalance[];
}): AdminBalanceRow[] {
  return assetBalanceViews(userBalances(input.balances)).map((balance) => ({
    userId: input.userId,
    userLabel: input.userLabel,
    asset: balance.asset,
    decimals: balance.decimals,
    availableMinor: balance.availableMinor,
    available: balance.available,
    heldMinor: balance.heldMinor,
    held: balance.held,
    totalMinor: balance.totalMinor,
    total: balance.total,
    accounts: balance.accounts.map((account) => ({
      code: account.code,
      bucket: account.bucket,
      balance: account.balance,
      entries: account.entries,
    })),
  }));
}

/**
 * The reconciliation check the drill-down shows.
 *
 * Both sides are sourced from the same `AccountBalance[]`; the comparison is
 * still worth making explicit because it proves the console took the ledger
 * route rather than a stored total, and it gives the test one named function to
 * assert on. A missing asset on either side is a difference, not a zero.
 */
export function reconcileAdminBalances(input: {
  consoleRows: readonly AdminBalanceRow[];
  accountBalances: readonly AccountBalance[];
}): { ok: boolean; differences: string[] } {
  const account = new Map(
    assetBalanceViews(userBalances(input.accountBalances)).map((balance) => [balance.asset, balance]),
  );
  const differences: string[] = [];
  for (const row of input.consoleRows) {
    const match = account.get(row.asset);
    if (!match) {
      differences.push(`${row.asset}: the console has ${row.total} and /account has no such asset.`);
      continue;
    }
    if (match.availableMinor !== row.availableMinor || match.heldMinor !== row.heldMinor || match.totalMinor !== row.totalMinor) {
      differences.push(
        `${row.asset}: console available ${row.available} / held ${row.held} / total ${row.total} does not match /account available ${match.available} / held ${match.held} / total ${match.total}.`,
      );
    }
    account.delete(row.asset);
  }
  for (const [asset, remaining] of account) {
    differences.push(`${asset}: /account has ${remaining.total} and the console has no such row.`);
  }
  return { ok: differences.length === 0, differences };
}

// ─────────────────────────────────────────────────────────────────────────────
// The correcting entry: validate, state the effect, then post and audit.
// ─────────────────────────────────────────────────────────────────────────────

export const CORRECTION_DIRECTIONS = ["CREDIT", "DEBIT"] as const;
export type CorrectionDirection = (typeof CORRECTION_DIRECTIONS)[number];

export type ParsedLedgerCorrection = {
  userId: string;
  asset: string;
  decimals: number;
  amount: string;
  amountMinor: MinorUnits;
  direction: CorrectionDirection;
  reason: string;
  idempotencyKey: string;
};

export type LedgerCorrectionValidation =
  | { valid: true; value: ParsedLedgerCorrection }
  | { valid: false; error: string };

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ASSET = /^[A-Za-z0-9]{2,12}$/;
const DECIMAL_AMOUNT = /^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/;

export function validateLedgerCorrection(input: unknown): LedgerCorrectionValidation {
  if (!isRecord(input)) return { valid: false, error: "A correction must be an object." };
  const userId = typeof input.userId === "string" ? input.userId.trim() : "";
  if (!IDENTIFIER.test(userId)) return { valid: false, error: "A target user id is required." };

  const asset = typeof input.asset === "string" ? input.asset.trim().toUpperCase() : "";
  if (!ASSET.test(asset)) return { valid: false, error: "An asset symbol of 2–12 letters or digits is required." };

  const decimals = input.decimals;
  if (typeof decimals !== "number" || !Number.isSafeInteger(decimals) || decimals < 0 || decimals > 18) {
    return { valid: false, error: "Decimals must be a whole number between 0 and 18." };
  }

  const amount = typeof input.amount === "string" ? input.amount.trim() : "";
  if (!DECIMAL_AMOUNT.test(amount)) {
    return { valid: false, error: "The amount must be a positive decimal such as 10 or 10.5, with no sign or exponent." };
  }
  let amountMinor: MinorUnits;
  try {
    amountMinor = minorUnitsFromDecimalString(amount, decimals);
  } catch (error) {
    return { valid: false, error: error instanceof Error ? error.message : "The amount could not be read." };
  }
  if (amountMinor === "0") return { valid: false, error: "A correction of zero would change nothing; enter an amount above zero." };

  const direction = typeof input.direction === "string" ? input.direction.trim().toUpperCase() : "";
  if (!(CORRECTION_DIRECTIONS as readonly string[]).includes(direction)) {
    return { valid: false, error: "Direction must be CREDIT (add to the account) or DEBIT (remove from it)." };
  }

  const reason = typeof input.reason === "string" ? input.reason.trim().replace(/\s+/g, " ") : "";
  if (reason.length < 3 || reason.length > 200) {
    return { valid: false, error: "A reason of 3–200 characters is required; it is stored in the audit event." };
  }

  const idempotencyKey = typeof input.idempotencyKey === "string" ? input.idempotencyKey.trim() : "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(idempotencyKey)) {
    return { valid: false, error: "An idempotency key of 8–128 characters is required so a retry cannot post twice." };
  }

  return {
    valid: true,
    value: {
      userId,
      asset,
      decimals,
      amount,
      amountMinor,
      direction: direction as CorrectionDirection,
      reason,
      idempotencyKey,
    },
  };
}

/**
 * What the action will do, said before it runs.
 *
 * This is information, not a prompt: the panel prints it beside the button and
 * the button runs in one step. The owner's action is the authorisation.
 */
export function ledgerCorrectionEffectText(input: {
  value: ParsedLedgerCorrection;
  userLabel: string;
  beforeAvailable: string;
  beforeTotal: string;
}): string {
  const sign = input.value.direction === "CREDIT" ? "+" : "−";
  const verb = input.value.direction === "CREDIT" ? "adds to" : "removes from";
  return [
    `Posts one balanced ADMIN_CORRECTION of ${sign}${input.value.amount} ${input.value.asset} on ${input.userLabel}.`,
    `It ${verb} that account's available balance, which is ${input.beforeAvailable} ${input.value.asset} now (total ${input.beforeTotal}), and takes the opposite leg on the platform treasury.`,
    `The exact balances before and after are read from the ledger when it runs and written to the audit event with the actor and the reason.`,
  ].join(" ");
}

/**
 * The record a correcting entry's audit event points at.
 *
 * The account is the target: pointing the event at the ledger transaction would
 * put it on the operator's timeline but not on the timeline of the person whose
 * balance changed. The transaction id stays in the payload.
 */
export function ledgerCorrectionAuditObject(targetUserId: string): { objectType: "User"; objectId: string } {
  return { objectType: "User", objectId: targetUserId };
}

export function ledgerCorrectionAuditPayload(input: {
  actorUserId: string;
  targetUserId: string;
  userLabel: string;
  asset: string;
  amount: string;
  amountMinor: string;
  direction: CorrectionDirection;
  reason: string;
  transactionId: string;
  availableAccountCode: string;
  treasuryAccountCode: string;
  before: { available: string; total: string };
  after: { available: string; total: string };
}): string {
  return JSON.stringify({
    actor: { type: "User", id: input.actorUserId },
    target: { type: "User", id: input.targetUserId, label: input.userLabel },
    asset: input.asset,
    amount: input.amount,
    amountMinor: input.amountMinor,
    direction: input.direction,
    reason: input.reason,
    ledgerTransactionId: input.transactionId,
    accounts: { available: input.availableAccountCode, treasury: input.treasuryAccountCode },
    before: input.before,
    after: input.after,
  });
}

/**
 * The two legs of a correction.
 *
 * A credit adds to the account and takes the same amount from treasury; a debit
 * does the reverse. Both are stated as positive amounts with a direction, which
 * is the ledger's own rule, so an unbalanced or negative-value correction cannot
 * be expressed here at all.
 */
export function ledgerCorrectionPostings(input: {
  direction: CorrectionDirection;
  amountMinor: MinorUnits;
  availableAccountId: string;
  treasuryAccountId: string;
}): LedgerPosting[] {
  const userDirection: MoneyDirection = input.direction === "CREDIT" ? "CREDIT" : "DEBIT";
  const treasuryDirection: MoneyDirection = input.direction === "CREDIT" ? "DEBIT" : "CREDIT";
  return [
    { accountId: input.availableAccountId, direction: userDirection, amountMinor: input.amountMinor },
    { accountId: input.treasuryAccountId, direction: treasuryDirection, amountMinor: input.amountMinor },
  ];
}

/** The balance of one asset's user-owned accounts, signed and exact. */
export function assetBalance(
  balances: readonly AccountBalance[],
  asset: string,
): { available: string; availableMinor: string; total: string; totalMinor: string } {
  const own = userBalances(balances).filter((balance) => balance.asset === asset);
  const available = own
    .filter((balance) => balance.bucket === "AVAILABLE")
    .reduce((total, balance) => total + balance.balanceMinor, BigInt(0));
  const held = own
    .filter((balance) => balance.bucket === "WITHDRAWALS_RESERVED")
    .reduce((total, balance) => total + balance.balanceMinor, BigInt(0));
  const decimals = own[0]?.decimals ?? 0;
  return {
    available: decimalOf(available, decimals),
    availableMinor: available.toString(),
    total: decimalOf(available + held, decimals),
    totalMinor: (available + held).toString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Search and the drill-down timeline.
// ─────────────────────────────────────────────────────────────────────────────

export type AdminSearchKind = "wallet" | "transaction" | "order" | "identifier";

/** What a search term looks like, so the panel can say what it looked for. */
export function classifyAdminSearch(term: string): { kind: AdminSearchKind; value: string } {
  const value = term.trim();
  if (/^0x[0-9a-f]{40}$/i.test(value)) return { kind: "wallet", value: value.toLowerCase() };
  if (/^0x[0-9a-f]{64}$/i.test(value)) return { kind: "transaction", value: value.toLowerCase() };
  if (/^dev-order-|^ord[_-]/i.test(value)) return { kind: "order", value };
  return { kind: "identifier", value };
}

export type AdminSearchMatch = {
  kind: AdminRecordType | "user";
  id: string;
  label: string;
  detail: string;
  subjectUserId: string | null;
};

export type AdminTimelineCategory =
  | "ledger"
  | "decision"
  | "delivery"
  | "audit"
  | "signin"
  | "deposit"
  | "withdrawal"
  | "trade"
  | "support"
  | "note";

export type AdminTimelineItem = {
  id: string;
  category: AdminTimelineCategory;
  occurredAt: string;
  title: string;
  detail: string;
  source: string;
  /** The record this event belongs to, when the console can open one. */
  record?: { type: AdminRecordType; id: string };
};

export function mergeAdminTimeline(items: readonly AdminTimelineItem[]): AdminTimelineItem[] {
  return [...items].sort((left, right) => {
    const byTime = right.occurredAt.localeCompare(left.occurredAt);
    return byTime !== 0 ? byTime : right.id.localeCompare(left.id);
  });
}
