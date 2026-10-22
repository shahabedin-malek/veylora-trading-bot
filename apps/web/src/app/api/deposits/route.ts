import { NextRequest } from "next/server";
import { getAuthConfig, isSameOriginRequest } from "@/lib/auth/config";
import { authenticationGapResponse, getAccessRefusal } from "@/lib/auth/access-gate";
import { requireUser } from "@/lib/auth/session-store";
import type { IssuanceOutcome } from "@/lib/deposits/addresses";
import { readDepositPolicy } from "@/lib/deposits/policy";
import { describeDepositsForUser, runDepositWatcher } from "@/lib/deposits/service";
import type { Reason } from "@/lib/observability/reason";

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

function authError(error: unknown) {
  const refusal = getAccessRefusal(error);
  return refusal ? json({ error: refusal.error }, refusal.status) : null;
}

function reasonPayload(entries: readonly { network: string; reason: Reason }[]) {
  return entries.map((entry) => ({
    network: entry.network,
    code: entry.reason.code,
    message: entry.reason.message,
    variable: entry.reason.variable ?? null,
  }));
}

function issuancePayload(issuance: IssuanceOutcome) {
  return {
    created: issuance.created.map((row) => ({ network: row.network, address: row.address })),
    existing: issuance.existing.map((row) => ({ network: row.network, address: row.address })),
    skipped: reasonPayload(issuance.skipped),
  };
}

/**
 * The deposit surface.
 *
 * `GET` is the read the panel makes: the addresses this account has on every
 * enabled network, the deposits seen against them, and the running total that has
 * actually been credited. Reading it also *issues* any address the account does
 * not have yet — exactly once, because the address is a pure function of the seed
 * and the account's id — so an owner who signs in and looks sees their address
 * whether or not anything else has run.
 *
 * A deployment that cannot derive an address answers 200 with the gap named rather
 * than an error, because the page has to render an honest explanation: an
 * unconfigured seed is configuration, not a refusal, and a blank panel would say
 * nothing. Only a caller who cannot be authenticated is refused.
 */
export async function GET() {
  let user;
  try {
    user = await requireUser();
  } catch (error) {
    return authError(error) ?? json({ error: "Deposits are unavailable." }, 503);
  }

  try {
    const policy = readDepositPolicy();
    const { view, issuance } = await describeDepositsForUser({ userId: user.id, policy });
    return json({ ...view, issuance: issuancePayload(issuance) });
  } catch {
    return json({ error: "Deposits are unavailable." }, 503);
  }
}

/**
 * Ask the watcher to run now.
 *
 * The same run the scheduler makes, on demand — for an owner who has just sent a
 * transfer and does not want to wait for the next tick. It takes no input from the
 * caller: the run reads the chains and the issued addresses and writes what it
 * finds, so there is nothing here a caller could use to make the server credit
 * something. It is idempotent by construction, which is what makes it safe to
 * expose, and it is the reason the click-path can watch a deposit move from
 * pending to credited without waiting for a cron tick.
 */
export async function POST(request: NextRequest) {
  const config = getAuthConfig();
  if (!config) return authenticationGapResponse();
  if (!isSameOriginRequest(request, config)) return json({ error: "Request origin is not allowed." }, 403);

  let user;
  try {
    user = await requireUser();
  } catch (error) {
    return authError(error) ?? json({ error: "User authorization is unavailable." }, 503);
  }

  try {
    const policy = readDepositPolicy();
    const summary = await runDepositWatcher({ policy });
    const { view, issuance } = await describeDepositsForUser({ userId: user.id, policy });
    return json({
      ...view,
      issuance: issuancePayload(issuance),
      run: {
        networks: summary.networks,
        scanned: summary.scanned,
        observations: summary.observations,
        recorded: summary.recorded,
        duplicates: summary.duplicates,
        credited: summary.credited,
        reverted: summary.reverted,
        awaiting: summary.awaiting,
        worked: summary.worked,
        reason: summary.reason,
        skipped: reasonPayload(summary.skipped),
        failed: reasonPayload(summary.failed),
      },
    });
  } catch {
    return json({ error: "The deposit watcher could not complete." }, 503);
  }
}
