import { NextRequest } from "next/server";
import { authenticationGapResponse, getAccessRefusal } from "@/lib/auth/access-gate";
import { getAuthConfig, isSameOriginRequest } from "@/lib/auth/config";
import { requireUser } from "@/lib/auth/session-store";
import { reverseDepositForUser } from "@/lib/deposits/credit";
import { depositStore } from "@/lib/deposits/store";
import { readLedgerHealth } from "@/lib/ledger/invariants";
import { readLedgerView, statementCsvChunks, type Statement } from "@/lib/ledger/statements";
import { ledgerStore } from "@/lib/ledger/store";
import type { AccountBalance } from "@/lib/ledger/accounts";

/**
 * The ledger surface: what an account holds, the statement that explains it, and
 * the one movement the owner can ask for by hand.
 *
 * `GET` is read-only and it never invents a figure. The balances come from
 * deriving the entries, the statement comes from the same entries, and the
 * invariant status comes from reading the book — so the panel can say both "this
 * is what you hold" and "this is whether the book that says so adds up". A CSV
 * export is the *same* statement object rendered as text, which is what makes
 * "the export matches the screen" true by construction.
 *
 * `POST` takes exactly one action, named in the body: reversing a deposit credit.
 * It is deliberately not a generic "post a transaction" endpoint — an arbitrary
 * posting API would be an invitation to mint a balance — and it takes a *deposit
 * id* the caller can already see rather than an account or an amount. Reversing is
 * a bookkeeping compensation of a credit the account already holds, it is scoped
 * to the caller's own deposits, and it is audited either way.
 */

const MAX_RANGE_DAYS = 366;
const DEFAULT_RANGE_DAYS = 30;

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

function authError(error: unknown) {
  const refusal = getAccessRefusal(error);
  return refusal ? json({ error: refusal.error }, refusal.status) : null;
}

/**
 * The date range, from the query string.
 *
 * A date with no time means the whole day: `to=2026-10-16` runs to the last
 * millisecond of the 16th, so "filter to today" includes everything that happened
 * today — a range that excluded the day it named would be a trap.
 */
export function parseStatementRange(search: URLSearchParams, now: Date): { from: Date; to: Date } | { problem: string } {
  const read = (value: string | null, kind: "from" | "to"): Date | string | null => {
    if (value === null || value.trim() === "") return null;
    const trimmed = value.trim();
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(trimmed);
    const parsed = new Date(dateOnly ? `${trimmed}T00:00:00.000Z` : trimmed);
    if (Number.isNaN(parsed.getTime())) return `The "${kind}" value ${JSON.stringify(value)} is not a date.`;
    if (dateOnly && kind === "to") parsed.setUTCHours(23, 59, 59, 999);
    return parsed;
  };

  const from = read(search.get("from"), "from");
  const to = read(search.get("to"), "to");
  if (typeof from === "string") return { problem: from };
  if (typeof to === "string") return { problem: to };

  const start = from ?? new Date(now.getTime() - DEFAULT_RANGE_DAYS * 24 * 60 * 60 * 1000);
  const end = to ?? now;
  if (start.getTime() > end.getTime()) {
    return { problem: `The statement's start (${start.toISOString()}) is after its end (${end.toISOString()}).` };
  }
  if (end.getTime() - start.getTime() > MAX_RANGE_DAYS * 24 * 60 * 60 * 1000) {
    return { problem: `A statement covers at most ${MAX_RANGE_DAYS} days; narrow the range.` };
  }
  return { from: start, to: end };
}

function balancePayload(balance: AccountBalance) {
  return {
    accountId: balance.accountId,
    code: balance.code,
    asset: balance.asset,
    decimals: balance.decimals,
    bucket: balance.bucket,
    label: balance.label,
    balanceMinor: balance.balanceMinorText,
    balance: balance.decimal,
    entryCount: balance.entryCount,
    creditLineMinor: balance.creditLineMinor === null ? null : balance.creditLineMinor.toString(),
  };
}

function statementPayload(statement: Statement) {
  return {
    from: statement.from,
    to: statement.to,
    lines: statement.lines.map((line) => ({
      entryId: line.entryId,
      transactionId: line.transactionId,
      kind: line.kind,
      occurredAt: line.occurredAt,
      asset: line.asset,
      direction: line.direction,
      amount: line.decimal,
      amountMinor: line.amountMinor,
      accountCode: line.accountCode,
      accountLabel: line.accountLabel,
      counterpartyCode: line.counterpartyCode,
      counterpartyLabel: line.counterpartyLabel,
      sourceType: line.sourceType,
      sourceId: line.sourceId,
      memo: line.memo,
      reversesTransactionId: line.reversesTransactionId,
    })),
    totals: statement.totals.map((total) => ({
      asset: total.asset,
      decimals: total.decimals,
      in: total.inDecimal,
      out: total.outDecimal,
      net: total.netDecimal,
      netMinor: total.netMinor,
      opening: total.openingDecimal,
      closing: total.closingDecimal,
      lines: total.lineCount,
    })),
    accounts: statement.accounts.map(balancePayload),
    // The page says how much of the range it is not showing, so a cut-off list is
    // never mistaken for the whole history.
    truncated: statement.truncated,
    lineCount: statement.lineCount,
    headline: statement.headline
      ? { asset: statement.headline.asset, net: statement.headline.netDecimal, lines: statement.headline.lineCount }
      : null,
  };
}

export async function GET(request: NextRequest) {
  let user;
  try {
    user = await requireUser();
  } catch (error) {
    return authError(error) ?? json({ error: "The ledger is unavailable." }, 503);
  }

  const search = new URL(request.url).searchParams;
  const range = parseStatementRange(search, new Date());
  if ("problem" in range) return json({ error: range.problem }, 400);

  try {
    // The CSV export is streamed from the same fold the panel reads, so a year of
    // history is written batch by batch rather than collected into one string.
    if (search.get("format") === "csv") {
      const filename = `veylora-ledger-${range.from.toISOString().slice(0, 10)}-to-${range.to.toISOString().slice(0, 10)}.csv`;
      const encoder = new TextEncoder();
      const chunks = statementCsvChunks(ledgerStore, { userId: user.id, from: range.from, to: range.to });
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          const next = await chunks.next();
          if (next.done) controller.close();
          else controller.enqueue(encoder.encode(next.value));
        },
        async cancel() {
          await chunks.return(undefined);
        },
      });
      return new Response(body, {
        status: 200,
        headers: {
          "Cache-Control": "no-store",
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${filename}"`,
        },
      });
    }

    const view = await readLedgerView(ledgerStore, { userId: user.id, from: range.from, to: range.to });
    // The book's own health is read beside the balance, because "here is what you
    // hold" is only worth showing with "and the book that says so adds up".
    // A book-wide invariant sweep reads every entry, so the page accepts a report
    // up to half a minute old and shows the moment it was checked. The runner's own
    // ledger-invariants job calls without a bound and always re-checks.
    const health = await readLedgerHealth(ledgerStore, { maxAgeMs: 30_000 });
    return json({
      balances: view.balances.map(balancePayload),
      platform: view.platform.map(balancePayload),
      statement: statementPayload(view.statement),
      ledger: {
        status: health.status,
        detail: health.detail,
        counts: health.counts,
        violations: health.violations,
        checkedAt: health.checkedAt,
      },
      readAt: view.readAt,
    });
  } catch {
    return json({ error: "The ledger could not be read." }, 503);
  }
}

export async function POST(request: NextRequest) {
  const config = getAuthConfig();
  if (!config) return authenticationGapResponse();
  if (!isSameOriginRequest(request, config)) return json({ error: "Request origin is not allowed." }, 403);

  let user;
  try {
    user = await requireUser();
  } catch (error) {
    return authError(error) ?? json({ error: "The ledger is unavailable." }, 503);
  }

  const body: unknown = await request.json().catch(() => null);
  const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const action = typeof record.action === "string" ? record.action.trim() : "";
  if (action !== "reverse-deposit") {
    return json(
      {
        error:
          "The ledger accepts one action: reverse-deposit, with the id of a deposit credit to compensate. " +
          `Received ${action === "" ? "no action" : JSON.stringify(action)}.`,
      },
      400,
    );
  }
  const depositId = typeof record.depositId === "string" ? record.depositId.trim() : "";
  if (!depositId) return json({ error: "reverse-deposit needs the depositId of the credit to reverse." }, 400);

  try {
    const outcome = await reverseDepositForUser({
      userId: user.id,
      depositId,
      store: depositStore,
      now: new Date(),
      ...(typeof record.memo === "string" && record.memo.trim() ? { memo: record.memo.trim().slice(0, 200) } : {}),
    });

    if (outcome.reason?.code === "NOT_PERMITTED") {
      return json({ error: outcome.reason.message }, 404);
    }
    const view = await readLedgerView(ledgerStore, {
      userId: user.id,
      from: new Date(Date.now() - DEFAULT_RANGE_DAYS * 24 * 60 * 60 * 1000),
      to: new Date(),
    });
    if (!outcome.reversed) {
      return json(
        {
          error: outcome.reason?.message ?? "The reversal was refused.",
          reason: outcome.reason,
          statement: statementPayload(view.statement),
          balances: view.balances.map(balancePayload),
        },
        409,
      );
    }
    return json({
      reversed: true,
      transactionId: outcome.transactionId,
      depositId,
      statement: statementPayload(view.statement),
      balances: view.balances.map(balancePayload),
    });
  } catch {
    return json({ error: "The reversal could not be applied." }, 503);
  }
}
