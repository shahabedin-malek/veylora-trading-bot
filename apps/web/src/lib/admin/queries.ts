import { prisma } from "@/lib/db";
import { ledgerStore } from "@/lib/ledger/store";
import { deriveBalances, type AccountBalance } from "@/lib/ledger/accounts";
import { balancesForUser } from "@/lib/ledger/statements";
import type { LedgerAccountRow } from "@/lib/ledger/integer-cent-ledger";
import { minorToDecimal } from "@/lib/fees/amounts";
import { getRiskPolicySettings, RISK_LIMIT_FIELDS } from "@/lib/risk-controls/settings";
import { strategyDefinition } from "@/lib/strategies/decide";
import { linkedTicketsFor } from "@/lib/support/repository";
import { ticketThreadCounts } from "@/lib/support/tickets";
import { loadUserTimeline, type UserTimelineCounts } from "@/lib/support/timeline";
import {
  adminBalanceRows,
  normalizeAdminColumns,
  normalizeAdminFilters,
  reconcileAdminBalances,
  rowMatchesQuery,
  type AdminBalanceRow,
  type AdminFilters,
  type AdminRecordType,
  type AdminRow,
  type AdminSectionConfig,
  type AdminSearchMatch,
  type AdminTimelineItem,
  type SavedAdminView,
  type SavedViewPersistence,
  adminSection,
} from "@/lib/admin/views";

/**
 * The database half of the admin console.
 *
 * Reads are bounded and honest: a list that cannot be read throws, so the route
 * answers with a named failure instead of an empty table that looks like "no
 * users". Filtering by `q` happens in the process after a bounded read, because
 * the console searches across a wallet, an id and a hash in one box and SQL
 * `contains` is case-sensitive on Postgres but not on the SQLite development
 * database — doing it in one place keeps both deployments answering alike.
 */

const MAX_ROWS = 250;
const MAX_LEDGER_ENTRIES = 1_500;

const USER_LABEL = {
  select: {
    id: true,
    walletIdentity: {
      where: { revokedAt: null },
      orderBy: { verifiedAt: "desc" },
      take: 1,
      select: { addressDisplay: true },
    },
    roles: {
      where: { scope: "global", revokedAt: null },
      orderBy: { createdAt: "desc" },
      take: 1,
      select: { role: true },
    },
  },
} as const;

type UserLabelRow = {
  id: string;
  walletIdentity: { addressDisplay: string }[];
  roles?: { role: string }[];
};

function userLabel(user: UserLabelRow | null | undefined): string {
  if (!user) return "unknown account";
  return user.walletIdentity[0]?.addressDisplay ?? user.id;
}

function stamp(value: Date | null | undefined): string {
  return value ? value.toISOString().replace("T", " ").slice(0, 19) + " UTC" : "—";
}

function dateRange(filters: AdminFilters): { gte?: Date; lte?: Date } | undefined {
  const gte = filters.from ? new Date(`${filters.from}T00:00:00.000Z`) : undefined;
  const lte = filters.to ? new Date(`${filters.to}T23:59:59.999Z`) : undefined;
  return gte || lte ? { ...(gte ? { gte } : {}), ...(lte ? { lte } : {}) } : undefined;
}

export type AdminListResult = {
  section: string;
  label: string;
  description: string;
  filters: AdminFilters;
  columns: string[];
  availableColumns: { key: string; label: string }[];
  rows: AdminRow[];
  total: number;
  readAt: string;
  truncated: boolean;
};

export async function listAdminSection(
  section: AdminSectionConfig,
  rawFilters: AdminFilters,
  chosenColumns: readonly string[],
): Promise<AdminListResult> {
  const filters = normalizeAdminFilters(section, rawFilters);
  const rows = await readSectionRows(section, filters);
  const filtered = filters.q ? rows.filter((row) => rowMatchesQuery(row, filters.q!)) : rows;
  return {
    section: section.id,
    label: section.label,
    description: section.description,
    filters,
    columns: [...chosenColumns],
    availableColumns: section.columns.map(({ key, label }) => ({ key, label })),
    rows: filtered.slice(0, MAX_ROWS),
    total: filtered.length,
    readAt: new Date().toISOString(),
    truncated: filtered.length > MAX_ROWS,
  };
}

async function readSectionRows(section: AdminSectionConfig, filters: AdminFilters): Promise<AdminRow[]> {
  switch (section.id) {
    case "users":
      return readUsers(filters);
    case "wallets":
      return readWallets(filters);
    case "balances":
      return readBalances(filters);
    case "ledger":
      return readLedger(filters);
    case "deposits":
      return readDeposits(filters);
    case "withdrawals":
      return readWithdrawals(filters);
    case "orders":
      return readOrders(filters);
    case "strategies":
      return readStrategies(filters);
    case "venue-keys":
      return readVenueKeys(filters);
    case "fees":
      return readFees();
    case "limits":
      return readLimits();
    case "switches":
      return readSwitches();
    case "audit":
      return readAudit(filters);
  }
}

function row(input: {
  id: string;
  recordType: AdminRecordType;
  subjectUserId?: string | null;
  cells: Record<string, string>;
  search?: string[];
}): AdminRow {
  return {
    id: input.id,
    recordType: input.recordType,
    subjectUserId: input.subjectUserId ?? null,
    cells: input.cells,
    search: input.search ?? [],
  };
}

async function readUsers(filters: AdminFilters): Promise<AdminRow[]> {
  const users = await prisma.user.findMany({
    where: {
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.role
        ? { roles: { some: { scope: "global", role: filters.role, revokedAt: null } } }
        : {}),
    },
    orderBy: { createdAt: "desc" },
    take: MAX_ROWS,
    select: {
      id: true,
      status: true,
      createdAt: true,
      lastSeenAt: true,
      walletIdentity: {
        where: { revokedAt: null },
        orderBy: { verifiedAt: "desc" },
        take: 1,
        select: { addressDisplay: true },
      },
      roles: {
        where: { scope: "global", revokedAt: null },
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { role: true },
      },
      _count: { select: { deposits: true, withdrawals: true, tradeOrders: true } },
    },
  });
  return users.map((user) =>
    row({
      id: user.id,
      recordType: "user",
      subjectUserId: user.id,
      cells: {
        wallet: user.walletIdentity[0]?.addressDisplay ?? "no mainnet wallet",
        role: user.roles[0]?.role ?? "VIEWER",
        status: user.status,
        lastSeenAt: stamp(user.lastSeenAt),
        createdAt: stamp(user.createdAt),
        userId: user.id,
      },
      search: [`${user._count.deposits} deposits`, `${user._count.withdrawals} withdrawals`, `${user._count.tradeOrders} orders`],
    }),
  );
}

async function readWallets(filters: AdminFilters): Promise<AdminRow[]> {
  const wallets = await prisma.walletIdentity.findMany({
    where: {
      revokedAt: null,
      ...(filters.accountType ? { accountType: filters.accountType } : {}),
      ...(filters.chain
        ? {
            OR: [
              { chainNamespace: { contains: filters.chain } },
              { chainReference: { contains: filters.chain } },
            ],
          }
        : {}),
    },
    orderBy: { verifiedAt: "desc" },
    take: MAX_ROWS,
    select: {
      id: true,
      userId: true,
      addressDisplay: true,
      chainNamespace: true,
      chainReference: true,
      accountType: true,
      verifiedAt: true,
      user: { select: USER_LABEL.select },
    },
  });
  return wallets.map((wallet) =>
    row({
      id: wallet.id,
      recordType: "wallet",
      subjectUserId: wallet.userId,
      cells: {
        address: wallet.addressDisplay,
        user: userLabel(wallet.user),
        chain: `${wallet.chainNamespace}:${wallet.chainReference}`,
        accountType: wallet.accountType,
        verifiedAt: stamp(wallet.verifiedAt),
      },
      search: [wallet.userId],
    }),
  );
}

type BalanceRowInput = { userId: string; userLabel: string; balances: AccountBalance[] };

async function readBalances(filters: AdminFilters): Promise<AdminRow[]> {
  const accounts = await prisma.ledgerAccount.findMany({
    where: {
      userId: { not: null },
      ...(filters.asset ? { asset: filters.asset } : {}),
    },
    orderBy: [{ userId: "asc" }, { asset: "asc" }],
    take: MAX_LEDGER_ENTRIES,
    select: {
      id: true,
      code: true,
      ownerType: true,
      bucket: true,
      asset: true,
      decimals: true,
      userId: true,
      creditLineMinor: true,
      createdAt: true,
    },
  });
  if (accounts.length === 0) return [];
  const entries = await prisma.ledgerEntry.findMany({
    where: { accountId: { in: accounts.map((account) => account.id) } },
    select: { accountId: true, direction: true, amountMinor: true },
  });
  const derived = deriveBalances({
    accounts: accounts.map((account) => ({
      ...account,
      ownerType: account.ownerType as LedgerAccountRow["ownerType"],
      bucket: account.bucket as LedgerAccountRow["bucket"],
    })),
    entries: entries.map((entry) => ({
      accountId: entry.accountId,
      direction: entry.direction === "DEBIT" ? "DEBIT" : "CREDIT",
      amountMinor: entry.amountMinor,
    })),
  });
  const byUser = new Map<string, BalanceRowInput>();
  for (const balance of derived) {
    if (!balance.userId) continue;
    const current = byUser.get(balance.userId) ?? { userId: balance.userId, userLabel: balance.userId, balances: [] };
    current.balances.push(balance);
    byUser.set(balance.userId, current);
  }
  const users = await prisma.user.findMany({
    where: { id: { in: [...byUser.keys()] } },
    select: USER_LABEL.select,
  });
  const labelById = new Map(users.map((user) => [user.id, userLabel(user)]));
  const rows: AdminRow[] = [];
  for (const group of byUser.values()) {
    const label = labelById.get(group.userId) ?? group.userId;
    for (const balance of adminBalanceRows({ userId: group.userId, userLabel: label, balances: group.balances })) {
      rows.push(balanceRow(balance));
    }
  }
  return rows;
}

function balanceRow(balance: AdminBalanceRow): AdminRow {
  return row({
    id: `${balance.userId}:${balance.asset}`,
    recordType: "balance",
    subjectUserId: balance.userId,
    cells: {
      user: balance.userLabel,
      asset: balance.asset,
      available: balance.available,
      held: balance.held,
      total: balance.total,
      accounts: balance.accounts.map((account) => `${account.bucket} ${account.balance}`).join(" · "),
    },
    search: [balance.availableMinor, balance.totalMinor, ...balance.accounts.map((account) => account.code)],
  });
}

type LedgerEntryQuery = Awaited<ReturnType<typeof findLedgerEntries>>;
async function findLedgerEntries(filters: AdminFilters) {
  const range = dateRange(filters);
  return prisma.ledgerEntry.findMany({
    where: {
      ...(filters.asset ? { asset: filters.asset } : {}),
      ...(range || filters.kind
        ? {
            transaction: {
              ...(range ? { occurredAt: range } : {}),
              ...(filters.kind ? { kind: filters.kind } : {}),
            },
          }
        : {}),
    },
    orderBy: [{ transaction: { occurredAt: "desc" } }, { sequence: "asc" }],
    take: 600,
    select: {
      id: true,
      transactionId: true,
      accountId: true,
      asset: true,
      amountMinor: true,
      decimals: true,
      direction: true,
      transaction: { select: { kind: true, occurredAt: true, memo: true, sourceId: true, sourceType: true } },
      account: { select: { code: true, userId: true, user: { select: USER_LABEL.select } } },
    },
  });
}

async function readLedger(filters: AdminFilters): Promise<AdminRow[]> {
  const entries: LedgerEntryQuery = await findLedgerEntries(filters);
  return entries.map((entry) =>
    row({
      id: entry.id,
      recordType: "ledger-entry",
      subjectUserId: entry.account.userId,
      cells: {
        occurredAt: stamp(entry.transaction.occurredAt),
        user: entry.account.userId ? userLabel(entry.account.user) : "platform",
        kind: entry.transaction.kind,
        asset: entry.asset,
        amount: minorToDecimal(BigInt(entry.amountMinor), entry.decimals),
        direction: entry.direction,
        account: entry.account.code,
        memo: entry.transaction.memo ?? "—",
        transaction: entry.transactionId,
      },
      search: [entry.transaction.sourceId ?? "", entry.decimals.toString()],
    }),
  );
}

async function readDeposits(filters: AdminFilters): Promise<AdminRow[]> {
  const deposits = await prisma.deposit.findMany({
    where: {
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.network ? { network: filters.network } : {}),
    },
    orderBy: { observedAt: "desc" },
    take: MAX_ROWS,
    select: {
      id: true,
      userId: true,
      network: true,
      tokenSymbol: true,
      amount: true,
      status: true,
      confirmations: true,
      txHash: true,
      observedAt: true,
      user: { select: USER_LABEL.select },
    },
  });
  return deposits.map((deposit) =>
    row({
      id: deposit.id,
      recordType: "deposit",
      subjectUserId: deposit.userId,
      cells: {
        observedAt: stamp(deposit.observedAt),
        user: deposit.userId ? userLabel(deposit.user) : "unmatched",
        network: deposit.network,
        asset: deposit.tokenSymbol,
        amount: deposit.amount,
        status: deposit.status,
        confirmations: deposit.confirmations.toString(),
        txHash: deposit.txHash,
      },
    }),
  );
}

async function readWithdrawals(filters: AdminFilters): Promise<AdminRow[]> {
  const withdrawals = await prisma.withdrawal.findMany({
    where: {
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.network ? { network: filters.network } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: MAX_ROWS,
    select: {
      id: true,
      userId: true,
      network: true,
      asset: true,
      decimals: true,
      netMinor: true,
      feeMinor: true,
      status: true,
      txHash: true,
      createdAt: true,
      user: { select: USER_LABEL.select },
    },
  });
  return withdrawals.map((withdrawal) =>
    row({
      id: withdrawal.id,
      recordType: "withdrawal",
      subjectUserId: withdrawal.userId,
      cells: {
        createdAt: stamp(withdrawal.createdAt),
        user: userLabel(withdrawal.user),
        network: withdrawal.network,
        asset: withdrawal.asset,
        net: minorToDecimal(BigInt(withdrawal.netMinor), withdrawal.decimals),
        fee: minorToDecimal(BigInt(withdrawal.feeMinor), withdrawal.decimals),
        status: withdrawal.status,
        txHash: withdrawal.txHash ?? "—",
      },
    }),
  );
}

async function readOrders(filters: AdminFilters): Promise<AdminRow[]> {
  const orders = await prisma.tradeOrder.findMany({
    where: {
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.venue ? { venue: filters.venue } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: MAX_ROWS,
    select: {
      id: true,
      userId: true,
      venue: true,
      market: true,
      side: true,
      status: true,
      notionalUsdCents: true,
      filledQuantity: true,
      requestedAmount: true,
      clientOrderId: true,
      venueOrderId: true,
      createdAt: true,
      user: { select: USER_LABEL.select },
    },
  });
  return orders.map((order) =>
    row({
      id: order.id,
      recordType: "order",
      subjectUserId: order.userId,
      cells: {
        createdAt: stamp(order.createdAt),
        user: userLabel(order.user),
        venue: order.venue,
        market: order.market,
        side: order.side,
        status: order.status,
        notional: `${(order.notionalUsdCents / 100).toFixed(2)} USD`,
        filled: `${order.filledQuantity} / ${order.requestedAmount}`,
      },
      search: [order.clientOrderId, order.venueOrderId ?? ""],
    }),
  );
}

async function readStrategies(filters: AdminFilters): Promise<AdminRow[]> {
  const activations = await prisma.strategyActivation.findMany({
    where: filters.status ? { status: filters.status } : {},
    orderBy: { updatedAt: "desc" },
    take: MAX_ROWS,
    select: {
      id: true,
      userId: true,
      status: true,
      strategyId: true,
      lastEvaluatedAt: true,
      runCount: true,
      lastOutcome: true,
      lastReasonCode: true,
      lastReasonMessage: true,
      killSwitch: { select: { active: true } },
      user: { select: USER_LABEL.select },
    },
  });
  return activations.map((activation) =>
    row({
      id: activation.id,
      recordType: "strategy",
      subjectUserId: activation.userId,
      cells: {
        user: userLabel(activation.user),
        state: activation.killSwitch?.active ? "KILLED" : activation.status,
        strategy: activation.strategyId
          ? strategyDefinition(activation.strategyId)?.label ?? activation.strategyId
          : "no strategy selected",
        lastEvaluatedAt: stamp(activation.lastEvaluatedAt),
        runCount: activation.runCount.toString(),
        outcome: activation.lastOutcome ?? "no pass recorded",
        reason: activation.lastReasonMessage ?? activation.lastReasonCode ?? "—",
      },
    }),
  );
}

async function readVenueKeys(filters: AdminFilters): Promise<AdminRow[]> {
  const credentials = await prisma.tradingVenueCredential.findMany({
    where: {
      revokedAt: null,
      ...(filters.venue ? { venue: filters.venue } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: MAX_ROWS,
    select: {
      id: true,
      userId: true,
      venue: true,
      label: true,
      readOnly: true,
      requestedPermissions: true,
      verifiedAt: true,
      lastCheckedAt: true,
      lastCheckError: true,
      fingerprint: true,
      user: { select: USER_LABEL.select },
    },
  });
  return credentials.map((credential) =>
    row({
      id: credential.id,
      recordType: "venue-key",
      subjectUserId: credential.userId,
      cells: {
        user: userLabel(credential.user),
        venue: credential.venue,
        label: credential.label,
        scope: credential.readOnly ? "read-only" : credential.requestedPermissions,
        verifiedAt: stamp(credential.verifiedAt),
        lastCheckedAt: stamp(credential.lastCheckedAt),
        problem: credential.lastCheckError ?? "—",
      },
      search: [credential.fingerprint],
    }),
  );
}

async function readFees(): Promise<AdminRow[]> {
  const fees = await prisma.feeSchedule.findMany({
    orderBy: { effectiveFrom: "desc" },
    take: 100,
    select: {
      id: true,
      effectiveFrom: true,
      performanceFeePercent: true,
      withdrawalFeesJson: true,
      networkCostsJson: true,
      tradingFeeBps: true,
      spreadBps: true,
      slippageBps: true,
      fundingBpsPerDay: true,
      createdAt: true,
    },
  });
  return fees.map((fee) =>
    row({
      id: fee.id,
      recordType: "fee",
      cells: {
        effectiveFrom: stamp(fee.effectiveFrom),
        performanceFee: `${fee.performanceFeePercent}%`,
        withdrawalFees: fee.withdrawalFeesJson,
        tradingCosts: `${fee.tradingFeeBps} bps fee · ${fee.spreadBps} spread · ${fee.slippageBps} slippage · ${fee.fundingBpsPerDay} funding`,
        createdAt: stamp(fee.createdAt),
      },
      search: [fee.networkCostsJson],
    }),
  );
}

async function readLimits(): Promise<AdminRow[]> {
  const settings = await getRiskPolicySettings();
  return RISK_LIMIT_FIELDS.map((limit) =>
    row({
      id: limit.field,
      recordType: "limit",
      cells: {
        field: limit.label,
        value: Array.isArray(settings[limit.field])
          ? (settings[limit.field] as string[]).join(", ") || "every configured venue"
          : String(settings[limit.field]),
        unit: limit.unit,
        effectiveFrom: settings.limitsEffectiveFrom[limit.field] ?? "not recorded",
      },
      search: [limit.field],
    }),
  );
}

async function readSwitches(): Promise<AdminRow[]> {
  const [settings, activations] = await Promise.all([
    getRiskPolicySettings(),
    prisma.strategyActivation.findMany({
      orderBy: { updatedAt: "desc" },
      take: MAX_ROWS,
      select: {
        id: true,
        userId: true,
        status: true,
        user: { select: USER_LABEL.select },
        killSwitch: { select: { active: true, reason: true, changedAt: true, changedByUserId: true } },
      },
    }),
  ]);
  const rows: AdminRow[] = [
    row({
      id: "global-kill",
      recordType: "switch",
      cells: {
        name: "Global kill switch",
        state: settings.killSwitchActive ? "ENGAGED" : "RELEASED",
        changedAt: settings.killSwitchChangedAt ?? "not recorded",
        changedBy: settings.killSwitchChangedByUserId ?? "not recorded",
        detail: "Stops every new intent on every account while engaged.",
      },
    }),
    row({
      id: "live-execution",
      recordType: "switch",
      cells: {
        name: "Live execution",
        state: settings.liveExecutionEnabled ? "ON" : "OFF",
        changedAt: settings.liveExecutionChangedAt ?? "not recorded",
        changedBy: settings.liveExecutionChangedByUserId ?? "not recorded",
        detail: "The only switch that makes a real-money venue selectable.",
      },
    }),
  ];
  for (const activation of activations) {
    rows.push(
      row({
        id: `strategy:${activation.id}`,
        recordType: "switch",
        subjectUserId: activation.userId,
        cells: {
          name: `Strategy stop · ${userLabel(activation.user)}`,
          state: activation.killSwitch?.active ? "ENGAGED" : "RELEASED",
          changedAt: stamp(activation.killSwitch?.changedAt),
          changedBy: activation.killSwitch?.changedByUserId ?? "not recorded",
          detail: activation.killSwitch?.reason ?? `Activation is ${activation.status}; the stop is per account.`,
        },
      }),
    );
  }
  return rows;
}

async function readAudit(filters: AdminFilters): Promise<AdminRow[]> {
  const range = dateRange(filters);
  const events = await prisma.auditEvent.findMany({
    where: {
      ...(filters.action ? { action: filters.action } : {}),
      ...(filters.objectType ? { objectType: filters.objectType } : {}),
      ...(range ? { occurredAt: range } : {}),
    },
    orderBy: { occurredAt: "desc" },
    take: 300,
    select: {
      id: true,
      action: true,
      objectType: true,
      objectId: true,
      outcome: true,
      redactedJson: true,
      occurredAt: true,
      actorUserId: true,
      actor: { select: USER_LABEL.select },
    },
  });
  return events.map((event) =>
    row({
      id: event.id,
      recordType: "audit",
      subjectUserId: event.actorUserId,
      cells: {
        occurredAt: stamp(event.occurredAt),
        actor: event.actorUserId ? userLabel(event.actor) : "system",
        action: event.action,
        objectType: event.objectType,
        objectId: event.objectId ?? "—",
        outcome: event.outcome,
        payload: event.redactedJson,
      },
      search: [event.actorUserId ?? ""],
    }),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Cross-entity search.
// ─────────────────────────────────────────────────────────────────────────────

export async function searchAdmin(term: string): Promise<AdminSearchMatch[]> {
  const value = term.trim();
  if (value.length < 2) return [];
  const matches: AdminSearchMatch[] = [];
  const [users, wallets, deposits, withdrawals, orders, audits, tickets] = await Promise.all([
    prisma.user.findMany({
      where: { id: { contains: value } },
      take: 10,
      select: { id: true, walletIdentity: { where: { revokedAt: null }, take: 1, select: { addressDisplay: true } } },
    }),
    prisma.walletIdentity.findMany({
      where: { addressCanonical: { contains: value.toLowerCase() }, revokedAt: null },
      take: 10,
      select: { id: true, userId: true, addressDisplay: true },
    }),
    prisma.deposit.findMany({
      where: { OR: [{ txHash: { contains: value.toLowerCase() } }, { id: value }] },
      take: 5,
      select: { id: true, userId: true, txHash: true, tokenSymbol: true, amount: true, status: true },
    }),
    prisma.withdrawal.findMany({
      where: { OR: [{ txHash: { contains: value.toLowerCase() } }, { id: value }] },
      take: 5,
      select: { id: true, userId: true, txHash: true, asset: true, decimals: true, netMinor: true, status: true },
    }),
    prisma.tradeOrder.findMany({
      where: { OR: [{ id: value }, { clientOrderId: { contains: value } }, { venueOrderId: { contains: value } }] },
      take: 10,
      select: { id: true, userId: true, market: true, status: true, clientOrderId: true },
    }),
    prisma.auditEvent.findMany({
      where: { OR: [{ objectId: value }, { id: value }] },
      take: 5,
      select: { id: true, action: true, objectType: true, objectId: true },
    }),
    prisma.supportTicket.findMany({
      where: { OR: [{ id: { contains: value } }, { subject: { contains: value } }] },
      take: 10,
      select: { id: true, userId: true, subject: true, status: true },
    }),
  ]);
  for (const user of users) {
    matches.push({
      kind: "user",
      id: user.id,
      label: user.walletIdentity[0]?.addressDisplay ?? user.id,
      detail: "Account record and its timeline",
      subjectUserId: user.id,
    });
  }
  for (const wallet of wallets) {
    matches.push({
      kind: "wallet",
      id: wallet.id,
      label: wallet.addressDisplay,
      detail: "Wallet identity",
      subjectUserId: wallet.userId,
    });
  }
  // A wallet is an identity, not the account: the record the operator wants next
  // is the account it belongs to, so it is returned beside the identity.
  const walletUserIds = [...new Set(wallets.map((wallet) => wallet.userId))];
  if (walletUserIds.length > 0) {
    const walletUsers = await prisma.user.findMany({
      where: { id: { in: walletUserIds } },
      select: { id: true, walletIdentity: { where: { revokedAt: null }, take: 1, select: { addressDisplay: true } } },
    });
    for (const user of walletUsers) {
      if (matches.some((match) => match.kind === "user" && match.id === user.id)) continue;
      matches.push({
        kind: "user",
        id: user.id,
        label: user.walletIdentity[0]?.addressDisplay ?? user.id,
        detail: "Account record and its timeline",
        subjectUserId: user.id,
      });
    }
  }
  for (const deposit of deposits) {
    matches.push({
      kind: "deposit",
      id: deposit.id,
      label: `${deposit.amount} ${deposit.tokenSymbol} · ${deposit.status}`,
      detail: `Deposit · ${deposit.txHash}`,
      subjectUserId: deposit.userId,
    });
  }
  for (const withdrawal of withdrawals) {
    matches.push({
      kind: "withdrawal",
      id: withdrawal.id,
      label: `${minorToDecimal(BigInt(withdrawal.netMinor), withdrawal.decimals)} ${withdrawal.asset} · ${withdrawal.status}`,
      detail: `Withdrawal · ${withdrawal.txHash ?? "no hash yet"}`,
      subjectUserId: withdrawal.userId,
    });
  }
  for (const order of orders) {
    matches.push({
      kind: "order",
      id: order.id,
      label: `${order.market} ${order.status}`,
      detail: `Order · ${order.clientOrderId}`,
      subjectUserId: order.userId,
    });
  }
  for (const ticket of tickets) {
    matches.push({
      kind: "ticket",
      id: ticket.id,
      label: ticket.subject,
      detail: `Support ticket · ${ticket.status} · ${ticket.userId}`,
      subjectUserId: ticket.userId,
    });
  }
  for (const audit of audits) {
    matches.push({
      kind: "audit",
      id: audit.id,
      label: audit.action,
      detail: `${audit.objectType} ${audit.objectId ?? ""}`,
      subjectUserId: null,
    });
  }
  return matches;
}

// ─────────────────────────────────────────────────────────────────────────────
// Drill-down: one record and one timeline.
// ─────────────────────────────────────────────────────────────────────────────

export type AdminRecordView = {
  type: AdminRecordType;
  id: string;
  title: string;
  subtitle: string;
  subjectUserId: string | null;
  fields: { label: string; value: string }[];
  balances: AdminBalanceRow[];
  reconciliation: { ok: boolean; differences: string[] } | null;
  timeline: AdminTimelineItem[];
  related: UserTimelineCounts;
  readAt: string;
};

export async function readAdminRecord(type: AdminRecordType, id: string): Promise<AdminRecordView | null> {
  const readAt = new Date().toISOString();
  if (type === "user") return userRecord(id, readAt);
  if (type === "wallet") {
    const wallet = await prisma.walletIdentity.findUnique({
      where: { id },
      select: { id: true, userId: true, addressDisplay: true, chainNamespace: true, chainReference: true, accountType: true, verifiedAt: true },
    });
    if (!wallet) return null;
    return composeRecord({
      type,
      id,
      title: wallet.addressDisplay,
      subtitle: `Wallet · ${wallet.chainNamespace}:${wallet.chainReference}`,
      subjectUserId: wallet.userId,
      fields: [
        { label: "Address", value: wallet.addressDisplay },
        { label: "Account type", value: wallet.accountType },
        { label: "Verified", value: stamp(wallet.verifiedAt) },
      ],
      readAt,
    });
  }
  if (type === "balance") {
    const [userId, asset] = id.split(":");
    if (!userId) return null;
    const record = await userRecord(userId, readAt);
    if (!record) return null;
    return {
      ...record,
      type,
      id,
      title: `${record.title} · ${asset ?? "all assets"}`,
      subtitle: `Ledger-derived balance${asset ? ` for ${asset}` : ""}`,
      balances: asset ? record.balances.filter((balance) => balance.asset === asset) : record.balances,
    };
  }
  if (type === "ledger-entry") {
    const entry = await prisma.ledgerEntry.findUnique({
      where: { id },
      select: {
        id: true,
        transactionId: true,
        asset: true,
        amountMinor: true,
        direction: true,
        account: { select: { code: true, userId: true, decimals: true, user: { select: USER_LABEL.select } } },
        transaction: { select: { kind: true, occurredAt: true, memo: true, sourceId: true } },
      },
    });
    if (!entry) return null;
    return composeRecord({
      type,
      id: entry.id,
      title: `${entry.transaction.kind} · ${minorToDecimal(BigInt(entry.amountMinor), entry.account.decimals)} ${entry.asset}`,
      subtitle: entry.account.code,
      subjectUserId: entry.account.userId,
      fields: [
        { label: "Direction", value: entry.direction },
        { label: "Transaction", value: entry.transactionId },
        { label: "Occurred", value: stamp(entry.transaction.occurredAt) },
        { label: "Memo", value: entry.transaction.memo ?? "—" },
      ],
      readAt,
    });
  }
  if (type === "deposit") {
    const deposit = await prisma.deposit.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        network: true,
        tokenSymbol: true,
        amount: true,
        status: true,
        txHash: true,
        observedAt: true,
        confirmations: true,
        reasonMessage: true,
      },
    });
    if (!deposit) return null;
    const tickets = await linkedTicketsFor("deposit", deposit.id);
    return composeRecord({
      type,
      id: deposit.id,
      title: `${deposit.amount} ${deposit.tokenSymbol}`,
      subtitle: `Deposit · ${deposit.status}`,
      subjectUserId: deposit.userId,
      fields: [
        { label: "Network", value: deposit.network },
        { label: "Transaction", value: deposit.txHash },
        { label: "Confirmations", value: deposit.confirmations.toString() },
        { label: "Observed", value: stamp(deposit.observedAt) },
        { label: "Reason", value: deposit.reasonMessage ?? "—" },
        linkedTicketField(tickets),
      ],
      readAt,
    });
  }
  if (type === "withdrawal") {
    const withdrawal = await prisma.withdrawal.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        network: true,
        asset: true,
        decimals: true,
        netMinor: true,
        feeMinor: true,
        status: true,
        destinationDisplay: true,
        txHash: true,
        createdAt: true,
        reasonMessage: true,
      },
    });
    if (!withdrawal) return null;
    const tickets = await linkedTicketsFor("withdrawal", withdrawal.id);
    return composeRecord({
      type,
      id: withdrawal.id,
      title: `${minorToDecimal(BigInt(withdrawal.netMinor), withdrawal.decimals)} ${withdrawal.asset}`,
      subtitle: `Withdrawal · ${withdrawal.status}`,
      subjectUserId: withdrawal.userId,
      fields: [
        { label: "Network", value: withdrawal.network },
        { label: "Destination", value: withdrawal.destinationDisplay },
        { label: "Fee", value: minorToDecimal(BigInt(withdrawal.feeMinor), withdrawal.decimals) },
        { label: "Transaction", value: withdrawal.txHash ?? "not broadcast" },
        { label: "Created", value: stamp(withdrawal.createdAt) },
        { label: "Reason", value: withdrawal.reasonMessage ?? "—" },
        linkedTicketField(tickets),
      ],
      readAt,
    });
  }
  if (type === "order") {
    const order = await prisma.tradeOrder.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        venue: true,
        market: true,
        side: true,
        status: true,
        clientOrderId: true,
        venueOrderId: true,
        notionalUsdCents: true,
        filledQuantity: true,
        requestedAmount: true,
        lastAttemptReason: true,
        createdAt: true,
      },
    });
    if (!order) return null;
    const tickets = await linkedTicketsFor("order", order.id);
    return composeRecord({
      type,
      id: order.id,
      title: `${order.market} ${order.side} · ${order.status}`,
      subtitle: `Order · ${order.venue}`,
      subjectUserId: order.userId,
      fields: [
        { label: "Client id", value: order.clientOrderId },
        { label: "Venue id", value: order.venueOrderId ?? "—" },
        { label: "Notional", value: `${(order.notionalUsdCents / 100).toFixed(2)} USD` },
        { label: "Filled", value: `${order.filledQuantity} / ${order.requestedAmount}` },
        { label: "Created", value: stamp(order.createdAt) },
        { label: "Last attempt", value: order.lastAttemptReason ?? "—" },
        linkedTicketField(tickets),
      ],
      readAt,
    });
  }
  if (type === "strategy") {
    const activation = await prisma.strategyActivation.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        status: true,
        strategyId: true,
        startedAt: true,
        stoppedAt: true,
        lastEvaluatedAt: true,
        lastOutcome: true,
        lastReasonCode: true,
        lastReasonMessage: true,
        runCount: true,
        killSwitch: { select: { active: true, reason: true, changedAt: true } },
      },
    });
    if (!activation) return null;
    const tickets = await linkedTicketsFor("strategy", activation.id);
    return composeRecord({
      type,
      id: activation.id,
      title: activation.strategyId ? strategyDefinition(activation.strategyId)?.label ?? activation.strategyId : "No strategy selected",
      subtitle: `Strategy · ${activation.status}`,
      subjectUserId: activation.userId,
      fields: [
        { label: "Started", value: stamp(activation.startedAt) },
        { label: "Stopped", value: stamp(activation.stoppedAt) },
        { label: "Last pass", value: stamp(activation.lastEvaluatedAt) },
        { label: "Passes", value: activation.runCount.toString() },
        { label: "Outcome", value: activation.lastOutcome ?? "—" },
        { label: "Reason", value: activation.lastReasonMessage ?? activation.lastReasonCode ?? "—" },
        { label: "Kill switch", value: activation.killSwitch?.active ? `ENGAGED · ${activation.killSwitch.reason ?? ""}` : "RELEASED" },
        linkedTicketField(tickets),
      ],
      readAt,
    });
  }
  if (type === "venue-key") {
    const key = await prisma.tradingVenueCredential.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        venue: true,
        label: true,
        readOnly: true,
        requestedPermissions: true,
        reportedPermissions: true,
        verifiedAt: true,
        lastCheckedAt: true,
        lastCheckError: true,
        fingerprint: true,
        createdAt: true,
      },
    });
    if (!key) return null;
    return composeRecord({
      type,
      id: key.id,
      title: `${key.label} · ${key.venue}`,
      subtitle: "Venue key (secret material is never read here)",
      subjectUserId: key.userId,
      fields: [
        { label: "Scope", value: key.readOnly ? "read-only" : key.requestedPermissions },
        { label: "Venue reported", value: key.reportedPermissions ?? "not reported" },
        { label: "Fingerprint", value: key.fingerprint },
        { label: "Verified", value: stamp(key.verifiedAt) },
        { label: "Last checked", value: stamp(key.lastCheckedAt) },
        { label: "Problem", value: key.lastCheckError ?? "—" },
      ],
      readAt,
    });
  }
  if (type === "fee") {
    const fee = await prisma.feeSchedule.findUnique({
      where: { id },
      select: { id: true, effectiveFrom: true, performanceFeePercent: true, withdrawalFeesJson: true, createdAt: true },
    });
    if (!fee) return null;
    return composeRecord({
      type,
      id: fee.id,
      title: `Fee version · ${stamp(fee.effectiveFrom)}`,
      subtitle: "Insert-only fee table version",
      subjectUserId: null,
      fields: [
        { label: "Performance fee", value: `${fee.performanceFeePercent}%` },
        { label: "Withdrawal fees", value: fee.withdrawalFeesJson },
        { label: "Written", value: stamp(fee.createdAt) },
      ],
      readAt,
    });
  }
  if (type === "limit" || type === "switch") {
    const settings = await getRiskPolicySettings();
    return composeRecord({
      type,
      id,
      title: id,
      subtitle: type === "limit" ? "Global risk limit" : "Global switch",
      subjectUserId: null,
      fields: [
        { label: "Kill switch", value: settings.killSwitchActive ? "ENGAGED" : "RELEASED" },
        { label: "Live execution", value: settings.liveExecutionEnabled ? "ON" : "OFF" },
        { label: "Live switch changed", value: settings.liveExecutionChangedAt ?? "not recorded" },
      ],
      readAt,
    });
  }
  if (type === "ticket") {
    const ticket = await prisma.supportTicket.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        subject: true,
        status: true,
        priority: true,
        assigneeUserId: true,
        relatedType: true,
        relatedId: true,
        createdAt: true,
        lastMessageAt: true,
        closedAt: true,
        user: { select: USER_LABEL.select },
        assignee: { select: USER_LABEL.select },
      },
    });
    if (!ticket) return null;
    const messages = await prisma.ticketMessage.findMany({
      where: { ticketId: ticket.id },
      take: 200,
      select: { visibility: true },
    });
    const counts = ticketThreadCounts(
      messages.map((message, index) => ({
        id: `count-${index}`,
        ticketId: ticket.id,
        authorType: "SYSTEM",
        authorUserId: null,
        visibility: message.visibility,
        body: "",
        createdAt: ticket.createdAt,
      })),
    );
    return composeRecord({
      type,
      id: ticket.id,
      title: ticket.subject,
      subtitle: `Support ticket · ${ticket.status}`,
      subjectUserId: ticket.userId,
      fields: [
        { label: "Account", value: userLabel(ticket.user) },
        { label: "Status", value: ticket.status },
        { label: "Priority", value: ticket.priority },
        { label: "Assignee", value: ticket.assignee ? userLabel(ticket.assignee) : "unassigned" },
        { label: "Opened", value: stamp(ticket.createdAt) },
        { label: "Last message", value: stamp(ticket.lastMessageAt) },
        { label: "Closed", value: stamp(ticket.closedAt) },
        {
          label: "Linked record",
          value: ticket.relatedType && ticket.relatedId ? `${ticket.relatedType} ${ticket.relatedId}` : "no linked record",
        },
        { label: "Thread", value: `${counts.public} public · ${counts.internal} internal` },
      ],
      readAt,
    });
  }
  if (type === "session") {
    const session = await prisma.authSession.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        deviceLabel: true,
        chainNamespace: true,
        chainReference: true,
        createdAt: true,
        lastSeenAt: true,
        expiresAt: true,
        revokedAt: true,
        revokedReason: true,
        user: { select: USER_LABEL.select },
      },
    });
    if (!session) return null;
    return composeRecord({
      type,
      id: session.id,
      title: session.deviceLabel,
      subtitle: `Sign-in · ${session.chainNamespace}:${session.chainReference}`,
      subjectUserId: session.userId,
      fields: [
        { label: "Account", value: userLabel(session.user) },
        { label: "Signed in", value: stamp(session.createdAt) },
        { label: "Last seen", value: stamp(session.lastSeenAt) },
        { label: "Expires", value: stamp(session.expiresAt) },
        { label: "Revoked", value: session.revokedAt ? `${stamp(session.revokedAt)} · ${session.revokedReason ?? "no reason recorded"}` : "no" },
      ],
      readAt,
    });
  }
  if (type === "delivery") {
    const delivery = await prisma.notificationDelivery.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        channel: true,
        target: true,
        subject: true,
        status: true,
        error: true,
        createdAt: true,
        deliveredAt: true,
        user: { select: USER_LABEL.select },
      },
    });
    if (!delivery) return null;
    return composeRecord({
      type,
      id: delivery.id,
      title: `${delivery.channel} · ${delivery.status}`,
      subtitle: `Alert delivery · ${delivery.subject}`,
      subjectUserId: delivery.userId,
      fields: [
        { label: "Account", value: userLabel(delivery.user) },
        { label: "Channel", value: delivery.channel },
        { label: "Target", value: delivery.target },
        { label: "Subject", value: delivery.subject },
        { label: "Status", value: delivery.status },
        { label: "Created", value: stamp(delivery.createdAt) },
        { label: "Delivered", value: stamp(delivery.deliveredAt) },
        { label: "Error", value: delivery.error ?? "—" },
      ],
      readAt,
    });
  }
  const event = await prisma.auditEvent.findUnique({
    where: { id },
    select: { id: true, action: true, objectType: true, objectId: true, outcome: true, redactedJson: true, occurredAt: true, actorUserId: true },
  });
  if (!event) return null;
  return composeRecord({
    type: "audit",
    id: event.id,
    title: event.action,
    subtitle: `${event.objectType} ${event.objectId ?? ""}`,
    subjectUserId: event.actorUserId,
    fields: [
      { label: "Outcome", value: event.outcome },
      { label: "Occurred", value: stamp(event.occurredAt) },
      { label: "Payload", value: event.redactedJson },
    ],
    readAt,
  });
}

async function userRecord(userId: string, readAt: string): Promise<AdminRecordView | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      status: true,
      createdAt: true,
      lastSeenAt: true,
      walletIdentity: {
        where: { revokedAt: null },
        orderBy: { verifiedAt: "desc" },
        take: 3,
        select: { addressDisplay: true, chainNamespace: true, chainReference: true, accountType: true, verifiedAt: true },
      },
      roles: { where: { scope: "global", revokedAt: null }, orderBy: { createdAt: "desc" }, take: 1, select: { role: true } },
    },
  });
  if (!user) return null;
  const balances = await balancesForUser(ledgerStore, userId);
  const consoleBalances = adminBalanceRows({ userId, userLabel: userLabel(user), balances });
  const reconciliation = reconcileAdminBalances({ consoleRows: consoleBalances, accountBalances: balances });
  const related = await loadUserTimeline(userId);
  return {
    type: "user",
    id: user.id,
    title: userLabel(user),
    subtitle: `Account · ${user.roles[0]?.role ?? "VIEWER"}`,
    subjectUserId: user.id,
    fields: [
      { label: "Status", value: user.status },
      { label: "Created", value: stamp(user.createdAt) },
      { label: "Last seen", value: stamp(user.lastSeenAt) },
      ...user.walletIdentity.map((identity, index) => ({
        label: `Wallet ${index + 1}`,
        value: `${identity.addressDisplay} · ${identity.chainNamespace}:${identity.chainReference} · ${identity.accountType}`,
      })),
    ],
    balances: consoleBalances,
    reconciliation,
    timeline: related.timeline,
    related: related.counts,
    readAt,
  };
}

/** The tickets that name this record, as one field so the link shows from both sides. */
function linkedTicketField(tickets: { id: string; subject: string; status: string }[]): { label: string; value: string } {
  return {
    label: "Support tickets",
    value:
      tickets.length === 0
        ? "no ticket names this record"
        : tickets.map((ticket) => `${ticket.subject} (${ticket.status}) · ${ticket.id}`).join(" | "),
  };
}

async function composeRecord(input: {
  type: AdminRecordType;
  id: string;
  title: string;
  subtitle: string;
  subjectUserId: string | null;
  fields: { label: string; value: string }[];
  readAt: string;
}): Promise<AdminRecordView> {
  const related = input.subjectUserId
    ? await loadUserTimeline(input.subjectUserId)
    : await loadObjectTimeline(input.id);
  return {
    type: input.type,
    id: input.id,
    title: input.title,
    subtitle: input.subtitle,
    subjectUserId: input.subjectUserId,
    fields: input.fields,
    balances: [],
    reconciliation: null,
    timeline: related.timeline,
    related: related.counts,
    readAt: input.readAt,
  };
}

async function loadObjectTimeline(objectId: string): Promise<{ timeline: AdminTimelineItem[]; counts: UserTimelineCounts }> {
  const audits = await prisma.auditEvent.findMany({
    where: { objectId },
    orderBy: { occurredAt: "desc" },
    take: 100,
    select: { id: true, action: true, objectType: true, objectId: true, outcome: true, occurredAt: true },
  });
  return {
    timeline: audits.map((audit) => ({
      id: `audit:${audit.id}`,
      category: "audit",
      occurredAt: audit.occurredAt.toISOString(),
      title: audit.action,
      detail: `${audit.objectType} ${audit.objectId ?? ""} · ${audit.outcome}`,
      source: "audit",
    })),
    counts: { ledger: 0, decisions: 0, deliveries: 0, audit: audits.length, signins: 0, deposits: 0, withdrawals: 0, trades: 0, support: 0 },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Saved views: the Prisma adapter behind the pure service.
// ─────────────────────────────────────────────────────────────────────────────

function parseViewRow(row: {
  id: string;
  userId: string;
  name: string;
  section: string;
  filtersJson: string;
  columnsJson: string;
  createdAt: Date;
  updatedAt: Date;
}): SavedAdminView | null {
  const section = adminSection(row.section);
  if (!section) return null;
  let filters: unknown = {};
  let columns: unknown = [];
  try {
    filters = JSON.parse(row.filtersJson);
  } catch {
    filters = {};
  }
  try {
    columns = JSON.parse(row.columnsJson);
  } catch {
    columns = [];
  }
  const normalized = normalizeAdminColumns(section, columns);
  return {
    id: row.id,
    ownerUserId: row.userId,
    name: row.name,
    section: section.id,
    filters: normalizeAdminFilters(section, {
      ...(typeof filters === "object" && filters !== null ? (filters as Record<string, unknown>) : {}),
    }),
    columns: normalized.valid && normalized.columns.length > 0 ? normalized.columns : [...section.defaultColumns],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export const prismaAdminViews: SavedViewPersistence = {
  async list(ownerUserId) {
    const rows = await prisma.adminSavedView.findMany({ where: { userId: ownerUserId }, orderBy: { updatedAt: "desc" } });
    return rows.map(parseViewRow).filter((view): view is SavedAdminView => view !== null);
  },
  async upsert(input) {
    const row = await prisma.adminSavedView.upsert({
      where: { userId_section_name: { userId: input.ownerUserId, section: input.section, name: input.name } },
      create: {
        userId: input.ownerUserId,
        section: input.section,
        name: input.name,
        filtersJson: JSON.stringify(input.filters),
        columnsJson: JSON.stringify(input.columns),
      },
      update: { filtersJson: JSON.stringify(input.filters), columnsJson: JSON.stringify(input.columns) },
    });
    const view = parseViewRow(row);
    if (!view) throw new Error("The saved view could not be read back.");
    return view;
  },
  async delete(ownerUserId, id) {
    const result = await prisma.adminSavedView.deleteMany({ where: { id, userId: ownerUserId } });
    return result.count > 0;
  },
};
