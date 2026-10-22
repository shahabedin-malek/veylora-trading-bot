import { prisma } from "@/lib/db";
import { depositStore } from "@/lib/deposits/store";
import { ledgerStore } from "@/lib/ledger/store";
import { readLedgerView } from "@/lib/ledger/statements";
import type { LedgerEntryRow, LedgerTransactionRow } from "@/lib/ledger/integer-cent-ledger";
import { withdrawalStore } from "@/lib/withdrawals/store";
import { importExternalHoldings, type ExternalImport } from "@/lib/portfolio/external";
import {
  buildAccountOverview,
  overviewFilename,
  overviewToCsv,
  overviewToJson,
  type AccountOverview,
  type DepositLike,
  type FilledOrderLike,
  type HistoryFilter,
  type WithdrawalLike,
} from "@/lib/portfolio/pnl";
import { createMarkPriceReader } from "@/lib/portfolio/prices";
import { buildAssistantPaperPerformance, type PaperOrderLike } from "@/lib/portfolio/paper-performance";
import { PAPER_VENUE_ID } from "@/lib/orders/venue";
import { parseOrderOrigin } from "@/lib/orders/origin";

/**
 * The account surface's own reads, in one place so the page's route and the export
 * route cannot disagree about what they are showing.
 *
 * This module is the only part of the fund-visibility work that touches the database
 * and the network. Everything it hands to {@link buildAccountOverview} is a row it
 * read; everything that decides a figure is in the pure module beside it. That split
 * is what makes the reconciliation testable with stated rows, and it is why the
 * export route is twelve lines rather than a second implementation.
 *
 * Two deliberate limits.
 *
 *  - **Positions are built from every fill, not from the filter.** A position is a
 *    holding *now*; the date filter is a question about history. Only the period's
 *    trading result is range-limited, and the summary says so.
 *  - **A mark that could not be read is reported, not substituted.** The failure is
 *    carried out of here (`markFailure`) so the page can say why a position has no
 *    market value instead of showing a figure the source never gave.
 */

const MAX_HISTORY_ROWS = 500;
const MAX_ORDERS = 1_000;

export type AccountView = {
  overview: AccountOverview;
  /** Present only when the caller asked for it: reading a venue is a network call. */
  external: ExternalImport | null;
  markFailure: string | null;
};

export function orderOccurredAt(order: { submittedAt: Date | null; createdAt: Date }): Date {
  return order.submittedAt ?? order.createdAt;
}

export async function readAccountView(input: {
  userId: string;
  filter: HistoryFilter;
  now?: Date;
  includeExternal?: boolean;
}): Promise<AccountView> {
  const now = input.now ?? new Date();
  const userId = input.userId;

  const [accounts, allAccounts, depositRows, withdrawalRows, orderRows] = await Promise.all([
    ledgerStore.listAccountsForUser(userId),
    ledgerStore.listAccounts(),
    depositStore.listDepositsForUser(userId, MAX_HISTORY_ROWS),
    withdrawalStore.listWithdrawalsForUser(userId, MAX_HISTORY_ROWS),
    prisma.tradeOrder.findMany({
      where: { userId },
      orderBy: { createdAt: "asc" },
      take: MAX_ORDERS,
      select: {
        id: true,
        venue: true,
        market: true,
        side: true,
        status: true,
        orderType: true,
        // Where the intent came from. The assistant's paper-performance block selects
        // on this column, so it is read beside the fills rather than inferred from a
        // sentence in the order's source note.
        origin: true,
        // The row column is `requestedAmount`; it holds the quantity the order was
        // for, and it is what the order's own stated unit price is derived from.
        requestedAmount: true,
        filledQuantity: true,
        notionalUsdCents: true,
        submittedAt: true,
        createdAt: true,
      },
    }),
  ]);

  // The ledger read and the account view are the same fold: balances from the
  // database's own sums and one page of statement lines, rather than loading every
  // entry the account has ever had to render a period. The account page showed the
  // cost of that when a year of history was 100,000 rows.
  const ledger = await readLedgerView(ledgerStore, {
    userId,
    from: input.filter.from,
    to: input.filter.to,
    now,
  });
  const ownEntries: { entry: LedgerEntryRow; transaction: LedgerTransactionRow }[] = [];
  const siblings: LedgerEntryRow[] = [];
  const accountById = new Map(
    allAccounts.map((account) => [
      account.id,
      { id: account.id, code: account.code, bucket: account.bucket, asset: account.asset, ownerType: account.ownerType },
    ]),
  );

  const deposits: DepositLike[] = depositRows.map((row) => ({
    id: row.id,
    network: row.network,
    asset: row.tokenSymbol,
    decimals: row.decimals,
    amount: row.amount,
    txHash: row.txHash,
    status: row.status,
    observedAt: row.observedAt,
    creditedAt: row.creditedAt,
  }));

  const withdrawals: WithdrawalLike[] = withdrawalRows.map((row) => ({
    id: row.id,
    network: row.network,
    asset: row.asset,
    decimals: row.decimals,
    amountMinor: row.amountMinor,
    feeMinor: row.feeMinor,
    netMinor: row.netMinor,
    status: row.status,
    txHash: row.txHash,
    cancelTxHash: row.cancelTxHash,
    createdAt: row.createdAt,
    confirmedAt: row.confirmedAt,
    destinationDisplay: row.destinationDisplay,
  }));

  const orders: FilledOrderLike[] = orderRows.map((row) => ({
    id: row.id,
    venue: row.venue,
    market: row.market,
    side: row.side === "SELL" ? "SELL" : "BUY",
    status: row.status,
    requestedQuantity: row.requestedAmount,
    filledQuantity: row.filledQuantity,
    notionalUsdCents: row.notionalUsdCents,
    occurredAt: orderOccurredAt(row),
  }));

  // Only markets that actually hold something are marked: a closed position needs no
  // price, and asking for one would be a request the answer to which nothing uses.
  const holdingMarkets = [...new Set(orders.filter((order) => order.status === "FILLED" || order.status === "PARTIALLY_FILLED").map((order) => order.market))];
  const readMarks = createMarkPriceReader();
  const { marks, failure } = await readMarks(holdingMarkets);

  // The assistant's block costs an origin-tagged subset of the same paper fills. The
  // whole paper book is passed beside the subset so a market row can say when the
  // account and the assistant's own fills disagree, instead of the subset being
  // presented as the position.
  const paperOrders: PaperOrderLike[] = orderRows
    .filter((row) => row.venue === PAPER_VENUE_ID)
    .map((row) => ({
      id: row.id,
      venue: row.venue,
      market: row.market,
      side: row.side === "SELL" ? "SELL" : "BUY",
      status: row.status,
      requestedQuantity: row.requestedAmount,
      filledQuantity: row.filledQuantity,
      notionalUsdCents: row.notionalUsdCents,
      occurredAt: orderOccurredAt(row),
      orderType: row.orderType,
      origin: parseOrderOrigin(row.origin),
    }));
  const paperPerformance = buildAssistantPaperPerformance({
    assistantOrders: paperOrders.filter((order) => order.origin === "assistant"),
    paperOrders,
    marks,
    now,
  });

  const overview = buildAccountOverview({
    userId,
    now,
    accounts,
    ownEntries,
    siblings,
    accountById,
    deposits,
    withdrawals,
    orders,
    marks,
    filter: input.filter,
    balances: ledger.balances,
    statement: ledger.statement,
    paperPerformance,
  });

  let external: ExternalImport | null = null;
  if (input.includeExternal) {
    const credentials = await prisma.tradingVenueCredential.findMany({
      where: { userId, revokedAt: null },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        venue: true,
        label: true,
        readOnly: true,
        credentialCiphertext: true,
        credentialIv: true,
        credentialAuthTag: true,
      },
    });
    external = await importExternalHoldings({
      credentials: credentials.map((credential) => ({
        id: credential.id,
        venue: credential.venue,
        label: credential.label,
        readOnly: credential.readOnly,
        ciphertext: credential.credentialCiphertext,
        iv: credential.credentialIv,
        authTag: credential.credentialAuthTag,
      })),
      deps: { now: () => now },
    });
  }

  return { overview, external, markFailure: failure };
}

export type AccountPayload = ReturnType<typeof accountPayload>;

/** The JSON the page and any script read. Figures are strings; nothing is recomputed. */
export function accountPayload(view: AccountView) {
  const { overview } = view;
  return {
    readAt: overview.readAt,
    range: overview.range,
    filter: overview.filter,
    balances: overview.balances,
    positions: overview.positions,
    pnl: overview.pnl,
    summary: overview.summary,
    paperPerformance: overview.paperPerformance,
    history: overview.history,
    totals: overview.totals,
    statementTotals: overview.statementTotals,
    sources: overview.sources,
    notes: overview.notes,
    external: view.external,
    markFailure: view.markFailure,
  };
}

/** The export, as text, with the file's name and type. One body builder, two routes. */
export function exportBody(view: AccountView, format: "csv" | "json"): {
  body: string;
  filename: string;
  contentType: string;
} {
  return format === "json"
    ? {
        body: overviewToJson(view.overview),
        filename: overviewFilename(view.overview, "json"),
        contentType: "application/json; charset=utf-8",
      }
    : {
        body: overviewToCsv(view.overview),
        filename: overviewFilename(view.overview, "csv"),
        contentType: "text/csv; charset=utf-8",
      };
}
