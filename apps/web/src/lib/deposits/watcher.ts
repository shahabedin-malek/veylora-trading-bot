import DecimalJS from "decimal.js";
import { formatUnits } from "viem";
import { reason, serializeReason, type Reason } from "@/lib/observability/reason";
import type { DepositAddressRow } from "./addresses";
import { DECIMALS_SELECTOR, decodeTransferLog, type ChainReader, type ChainReceipt } from "./chain";
import type { DepositNetworkPolicy } from "./policy";
import type { DepositRow, DepositStore, NewDepositRow } from "./store";
import type { DepositState } from "./states";

const Decimal = DecimalJS.clone({ precision: 80 });

/**
 * The watcher: what arrived on chain, what it means, and what it is worth.
 *
 * Three separated steps, because each has a different failure story:
 *
 *   1. **Scan** — read the chain and turn it into *observations*: facts about
 *      transfers (this token, this amount, this recipient, this block). No
 *      judgement, no database. A read that fails returns a reason; it never
 *      returns an empty result, because "the chain said nothing" and "the chain
 *      could not be read" must not look the same to an owner watching for money.
 *   2. **Classify** — a pure function from one observation plus the deployment's
 *      policy to a state and a sentence. Every case the phase names lives here:
 *      below the minimum, a token the owner has not enabled, a recipient that is
 *      not ours. Being pure is what makes them testable one by one.
 *   3. **Record** — write it once, keyed by the chain's own identity for the
 *      transfer. Re-reading a block range, restarting the process or running two
 *      watchers at once all end at the same row, so nothing can be credited
 *      twice. A re-read of an already-known transfer is *reported* (as a
 *      duplicate count) rather than silently discarded.
 *
 * Confirmations and crediting are the fourth and fifth steps and live next to
 * this file: `reconcilePendingDeposits` here, `credit.ts` for the transition that
 * makes an arrival money.
 */

export type TransferObservation = {
  network: string;
  chainId: number;
  kind: "erc20" | "native";
  txHash: string;
  /** The log's index in its transaction; -1 for a native transfer, which writes no log. */
  logIndex: number;
  blockNumber: number;
  blockHash: string;
  from: string;
  to: string;
  /** Null for a native transfer. */
  tokenAddress: string | null;
  tokenSymbol: string;
  decimals: number;
  rawAmount: string;
  amount: string;
  /** WATCHER: addressed to us. UNFILTERED: seen only because the wide scan is on. */
  origin: "WATCHER" | "UNFILTERED";
  evidence: Record<string, unknown>;
};

export type Classification = {
  state: DepositState;
  reason: Reason;
  /** The account this arrival belongs to, or null when the recipient is not ours. */
  attribution: { userId: string; depositAddressId: string } | null;
};

function normalise(address: string): string {
  return address.toLowerCase();
}

/**
 * What one arrival means. Pure: the same observation and context always produce
 * the same state and sentence, which is why every case below is testable on its
 * own and why two runners cannot disagree about an arrival.
 *
 * The order matters. An arrival we cannot attribute is unmatched regardless of
 * how much it is worth; a token we did not enable is not credited even if it is
 * worth a fortune; and the dust guard is only applied to an arrival that is
 * otherwise creditable — so the reason an owner reads is the first thing that is
 * wrong with it, not the least important one.
 */
export function classifyObservation(
  observation: TransferObservation,
  context: { policy: DepositNetworkPolicy; addresses: readonly DepositAddressRow[] },
): Classification {
  const ours = context.addresses.find((row) => normalise(row.address) === normalise(observation.to));
  if (!ours) {
    return {
      state: "UNMATCHED",
      attribution: null,
      reason: reason("UNKNOWN_RECIPIENT", {
        message: `This transfer's recipient (${observation.to}) is not a deposit address this deployment issued on ${context.policy.displayName}, so it was recorded without an account.`,
        detail: `transaction ${observation.txHash}`,
      }),
    };
  }

  const attribution = { userId: ours.userId, depositAddressId: ours.id };
  const enabledToken = context.policy.token;

  if (observation.kind === "native") {
    // Any asset is accepted, valued in USDT. A native coin cannot be credited as the
    // network's configured token, so it waits for the owner to put a USDT value on it
    // rather than disappearing behind a refusal.
    return {
      state: "AWAITING_VALUATION",
      attribution,
      reason: reason("TOKEN_AWAITING_VALUATION", {
        message: `The native coin (${context.policy.nativeSymbol}) arrived at your deposit address rather than ${enabledToken?.symbol ?? "the configured token"}. It is recorded and waits for the owner to credit it at its USDT value.`,
        detail: `${observation.amount} ${context.policy.nativeSymbol}`,
      }),
    };
  }

  if (!enabledToken || normalise(enabledToken.address) !== normalise(observation.tokenAddress ?? "")) {
    // Same rule for any ERC-20/BEP-20: it is money that arrived, so it is recorded
    // and surfaced for a valuation instead of being refused. It is never silently
    // credited under the network's own token, because that would invent a price.
    return {
      state: "AWAITING_VALUATION",
      attribution,
      reason: reason("TOKEN_AWAITING_VALUATION", {
        message: `The token ${observation.tokenSymbol} (${observation.tokenAddress}) is not the token this deployment configures on ${context.policy.displayName}${enabledToken ? ` (${enabledToken.symbol} at ${enabledToken.address})` : ""}. It is recorded and waits for the owner to credit it at a USDT value.`,
        detail: `${observation.amount} ${observation.tokenSymbol}`,
      }),
    };
  }

  const minimum = new Decimal(context.policy.minimumAmount);
  let amount: DecimalJS;
  try {
    amount = new Decimal(observation.amount);
  } catch {
    return {
      state: "BELOW_DUST",
      attribution,
      reason: reason("BELOW_MINIMUM_AMOUNT", {
        message: `The transfer's amount could not be read as a number, so it was recorded and not credited.`,
        detail: `raw amount ${observation.rawAmount}`,
      }),
    };
  }

  if (!amount.isFinite() || amount.lessThanOrEqualTo(0)) {
    return {
      state: "BELOW_DUST",
      attribution,
      reason: reason("BELOW_MINIMUM_AMOUNT", {
        message: `The transfer carries no amount, so it was recorded and not credited.`,
        detail: `raw amount ${observation.rawAmount}`,
      }),
    };
  }

  if (amount.lessThan(minimum)) {
    return {
      state: "BELOW_DUST",
      attribution,
      reason: reason("BELOW_MINIMUM_AMOUNT", {
        message: `The transfer of ${observation.amount} ${observation.tokenSymbol} is below this network's deposit minimum of ${minimum.toFixed()} ${observation.tokenSymbol}, so it was recorded and not credited.`,
        detail: `transaction ${observation.txHash}`,
      }),
    };
  }

  return {
    state: "PENDING",
    attribution,
    reason: reason("AWAITING_CONFIRMATIONS", {
      message: `The transfer of ${observation.amount} ${observation.tokenSymbol} is on chain and is waiting for ${context.policy.confirmations} confirmation(s).`,
      detail: `block ${observation.blockNumber}`,
    }),
  };
}

export type ScanResult = {
  network: string;
  head: number;
  fromBlock: number;
  toBlock: number;
  observations: TransferObservation[];
  /** Set when nothing was scanned, with the sentence that says why. */
  skipped: Reason | null;
};

/**
 * Read one network's window and turn it into observations.
 *
 * The token read filters on the **recipient** topic rather than on the deposit
 * token's contract, so an arrival in a token this deployment has never heard of
 * is still seen (and classified as `TOKEN_DISABLED`) instead of disappearing —
 * "we did not look" is a very different answer from "nothing arrived". Native
 * arrivals need blocks, because a native transfer writes no log at all.
 */
export async function scanNetwork(input: {
  policy: DepositNetworkPolicy;
  reader: ChainReader;
  addresses: readonly DepositAddressRow[];
  watchBlocks: number;
  scanUnfiltered: boolean;
  cursor: number | null;
}): Promise<ScanResult> {
  const { policy, reader, addresses, watchBlocks } = input;
  const head = await reader.blockNumber();
  const base: ScanResult = { network: policy.slug, head, fromBlock: 0, toBlock: 0, observations: [], skipped: null };

  if (addresses.length === 0) {
    return {
      ...base,
      skipped: reason("NO_ENTRY_CONDITION", {
        message: `No deposit address has been issued on ${policy.displayName} yet, so there was nothing to watch for.`,
      }),
    };
  }
  if (policy.token === null) {
    return {
      ...base,
      skipped: reason("MISSING_CONFIGURATION", {
        variable: policy.missing[0] ?? `DEPOSIT_TOKEN_ADDRESS_${policy.slug.toUpperCase().replace(/-/g, "_")}`,
        message: `No deposit token is configured for ${policy.displayName}, so its addresses cannot be watched.`,
      }),
    };
  }

  const cursor = input.cursor;
  const fromBlock = cursor === null ? Math.max(1, head - watchBlocks + 1) : cursor + 1;
  const toBlock = Math.min(head, fromBlock + watchBlocks - 1);
  if (fromBlock > head) {
    return {
      ...base,
      fromBlock,
      toBlock,
      skipped: reason("NOT_YET_DUE", {
        message: `The last watched block on ${policy.displayName} is ${cursor}; the chain is at ${head}, so there is no new block to read.`,
      }),
    };
  }

  const ourAddresses = addresses.map((row) => row.address);
  const observations: TransferObservation[] = [];
  const seen = new Set<string>();
  const decimalsCache = new Map<string, number>();

  const decimalsFor = async (contractAddress: string): Promise<number> => {
    const key = normalise(contractAddress);
    const cached = decimalsCache.get(key);
    if (cached !== undefined) return cached;
    const enabled = policy.token && normalise(policy.token.address) === key;
    if (enabled) {
      decimalsCache.set(key, policy.token!.decimals);
      return policy.token!.decimals;
    }
    // A token the owner did not enable, arriving anyway: read its own decimals so
    // the owner sees the amount in its units. A token that does not answer is
    // kept at 0 decimals and labelled with its raw amount — it is never credited
    // either way, and inventing a scale would be worse than showing none.
    try {
      const answer = await input.reader.call(contractAddress, DECIMALS_SELECTOR);
      const parsed = answer ? Number(BigInt(answer)) : Number.NaN;
      const decimals = Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 36 ? parsed : 0;
      decimalsCache.set(key, decimals);
      return decimals;
    } catch {
      decimalsCache.set(key, 0);
      return 0;
    }
  };

  const logs = await reader.getLogs({ fromBlock, toBlock, address: null, toAddresses: ourAddresses });
  for (const log of logs) {
    const transfer = decodeTransferLog(log);
    if (!transfer) continue;
    const key = `${log.transactionHash}:${log.logIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const decimals = await decimalsFor(transfer.tokenAddress);
    observations.push({
      network: policy.slug,
      chainId: policy.chainId,
      kind: "erc20",
      txHash: log.transactionHash,
      logIndex: log.logIndex,
      blockNumber: log.blockNumber,
      blockHash: log.blockHash,
      from: transfer.from,
      to: transfer.to,
      tokenAddress: transfer.tokenAddress,
      tokenSymbol: policy.token && normalise(policy.token.address) === normalise(transfer.tokenAddress) ? policy.token.symbol : "UNKNOWN TOKEN",
      decimals,
      rawAmount: transfer.rawAmount,
      amount: safeFormatUnits(transfer.rawAmount, decimals),
      origin: "WATCHER",
      evidence: { tokenAddress: transfer.tokenAddress, topics: log.topics, removed: log.removed, data: log.data },
    });
  }

  if (input.scanUnfiltered) {
    // The wide pass: every `Transfer` on the chain in this window, whether or not
    // it is addressed to us. It is the only read that can see money sent to an
    // address that is not one of ours — and it is off by default, because on a
    // busy chain that window is a very large answer.
    const allLogs = await reader.getLogs({ fromBlock, toBlock, address: null, toAddresses: null });
    for (const log of allLogs) {
      const transfer = decodeTransferLog(log);
      if (!transfer) continue;
      const key = `${log.transactionHash}:${log.logIndex}`;
      if (seen.has(key)) continue;
      if (ourAddresses.some((address) => normalise(address) === normalise(transfer.to))) continue;
      seen.add(key);
      const decimals = await decimalsFor(transfer.tokenAddress);
      observations.push({
        network: policy.slug,
        chainId: policy.chainId,
        kind: "erc20",
        txHash: log.transactionHash,
        logIndex: log.logIndex,
        blockNumber: log.blockNumber,
        blockHash: log.blockHash,
        from: transfer.from,
        to: transfer.to,
        tokenAddress: transfer.tokenAddress,
        tokenSymbol: "UNKNOWN TOKEN",
        decimals,
        rawAmount: transfer.rawAmount,
        amount: safeFormatUnits(transfer.rawAmount, decimals),
        origin: "UNFILTERED",
        evidence: { tokenAddress: transfer.tokenAddress, topics: log.topics, removed: log.removed, data: log.data },
      });
    }
  }

  for (let block = fromBlock; block <= toBlock; block += 1) {
    const record = await reader.getBlock(block);
    if (!record) continue;
    for (const transaction of record.transactions) {
      if (!transaction.to) continue;
      if (!ourAddresses.some((address) => normalise(address) === normalise(transaction.to!))) continue;
      const value = BigInt(transaction.value);
      if (value <= BigInt(0)) continue;
      const key = `${transaction.hash}:-1`;
      if (seen.has(key)) continue;
      seen.add(key);
      const nativeDecimals = 18;
      observations.push({
        network: policy.slug,
        chainId: policy.chainId,
        kind: "native",
        txHash: transaction.hash,
        logIndex: -1,
        blockNumber: block,
        blockHash: record.hash,
        from: transaction.from,
        to: transaction.to,
        tokenAddress: null,
        tokenSymbol: policy.nativeSymbol,
        decimals: nativeDecimals,
        rawAmount: value.toString(),
        amount: safeFormatUnits(value.toString(), nativeDecimals),
        origin: "WATCHER",
        evidence: { native: true, from: transaction.from, value: transaction.value },
      });
    }
  }

  return { ...base, fromBlock, toBlock, observations };
}

function safeFormatUnits(rawAmount: string, decimals: number): string {
  try {
    return formatUnits(BigInt(rawAmount), decimals);
  } catch {
    return rawAmount;
  }
}

export type RecordOutcome = { created: boolean; row: DepositRow };

/**
 * Write one observation down, once.
 *
 * The key is the chain's own identity for the transfer, so `insertDepositOnce`
 * returning "not created" *is* the duplicate answer — and the existing row is
 * left exactly as it is, which is what "replaying the same chain event credits
 * nothing a second time" means in practice. Only a genuine first sighting writes
 * the audit event and the row together.
 */
export async function recordObservation(input: {
  store: DepositStore;
  observation: TransferObservation;
  classification: Classification;
  now: Date;
}): Promise<RecordOutcome> {
  const { store, observation, classification, now } = input;
  const row: NewDepositRow = {
    userId: classification.attribution?.userId ?? null,
    depositAddressId: classification.attribution?.depositAddressId ?? null,
    network: observation.network,
    chainId: observation.chainId,
    tokenSymbol: observation.tokenSymbol,
    tokenAddress: observation.tokenAddress,
    decimals: observation.decimals,
    amount: observation.amount,
    rawAmount: observation.rawAmount,
    txHash: observation.txHash,
    logIndex: observation.logIndex,
    blockNumber: observation.blockNumber,
    blockHash: observation.blockHash,
    status: classification.state,
    reasonCode: classification.reason.code,
    reasonMessage: classification.reason.message,
    evidenceJson: JSON.stringify({
      ...observation.evidence,
      origin: observation.origin,
      from: observation.from,
      to: observation.to,
      rawAmount: observation.rawAmount,
      decimals: observation.decimals,
    }),
    origin: observation.origin,
    observedAt: now,
    lastCheckedAt: now,
    creditedAt: null,
    revertedAt: null,
  };

  return store.transaction(async (transaction) => {
    const inserted = await transaction.insertDepositOnce(row);
    if (!inserted.created) return inserted;
    await transaction.recordAudit({
      actorUserId: classification.attribution?.userId ?? null,
      action: "DEPOSIT_DETECTED",
      objectType: "Deposit",
      objectId: inserted.row.id,
      outcome: classification.state === "PENDING" ? "SUCCESS" : "REFUSED",
      payload: {
        network: observation.network,
        chainId: observation.chainId,
        txHash: observation.txHash,
        logIndex: observation.logIndex,
        blockNumber: observation.blockNumber,
        blockHash: observation.blockHash,
        tokenSymbol: observation.tokenSymbol,
        tokenAddress: observation.tokenAddress,
        amount: observation.amount,
        rawAmount: observation.rawAmount,
        recipient: observation.to,
        state: classification.state,
        reason: serializeReason(classification.reason),
        origin: observation.origin,
      },
    });
    return inserted;
  });
}

export type ReconcileResult = {
  checked: number;
  credited: number;
  reverted: number;
  awaiting: number;
};

/**
 * The second look: is a pending transfer still there, and how deep is it?
 *
 * A pending row is the only promise this phase makes that can still be broken by
 * the chain, so it is the only one re-read. Each pending transfer is verified
 * against its block hash: a receipt that no longer exists, or one whose block has
 * been replaced, is a reorg — the row becomes REVERTED with that reason and an
 * audit event, rather than sitting forever at "pending" while the owner waits.
 *
 * A credited row is *not* reverted here even if it later reorged below the
 * configured depth: crediting is final in this phase, and un-crediting money
 * already counted is a reconciliation decision for the ledger (phase 13). That
 * boundary is deliberate and is stated in the README rather than left implicit.
 */
export async function reconcilePendingDeposits(input: {
  store: DepositStore;
  policy: DepositNetworkPolicy;
  reader: ChainReader;
  head: number;
  now: Date;
  credit: (row: DepositRow, confirmations: number) => Promise<boolean>;
}): Promise<ReconcileResult> {
  const { store, policy, reader, head, now } = input;
  const pending = await store.listPendingByNetwork(policy.slug);
  const result: ReconcileResult = { checked: pending.length, credited: 0, reverted: 0, awaiting: 0 };

  for (const row of pending) {
    const receipt = await reader.getTransactionReceipt(row.txHash);
    if (!receipt || receipt.blockNumber !== row.blockNumber || normalise(receipt.blockHash) !== normalise(row.blockHash)) {
      const detail = !receipt
        ? `The chain no longer returns a receipt for ${row.txHash}.`
        : `It was recorded in block ${row.blockNumber} (${row.blockHash}) and the chain now has ${receipt.blockNumber} (${receipt.blockHash}).`;
      await store.transaction(async (transaction) => {
        await transaction.updateDeposit(row.id, {
          status: "REVERTED",
          reasonCode: "CHAIN_REORGANIZED",
          reasonMessage: `A reorganization removed this pending transfer, so it is no longer counted or expected to be credited. ${detail}`,
          revertedAt: now,
          lastCheckedAt: now,
        });
        await transaction.recordAudit({
          actorUserId: row.userId,
          action: "DEPOSIT_REVERTED",
          objectType: "Deposit",
          objectId: row.id,
          outcome: "REFUSED",
          payload: {
            network: row.network,
            txHash: row.txHash,
            logIndex: row.logIndex,
            amount: row.amount,
            tokenSymbol: row.tokenSymbol,
            recordedBlock: row.blockNumber,
            recordedBlockHash: row.blockHash,
            observedBlock: receipt?.blockNumber ?? null,
            observedBlockHash: receipt?.blockHash ?? null,
            reason: serializeReason(reason("CHAIN_REORGANIZED", { detail })),
          },
        });
      });
      result.reverted += 1;
      continue;
    }

    const confirmations = Math.max(0, head - row.blockNumber + 1);
    if (confirmations >= policy.confirmations) {
      const credited = await input.credit(row, confirmations);
      if (credited) result.credited += 1;
      continue;
    }

    await store.updateDeposit(row.id, {
      confirmations,
      status: "PENDING",
      reasonCode: "AWAITING_CONFIRMATIONS",
      reasonMessage: `The transfer of ${row.amount} ${row.tokenSymbol} has ${confirmations} confirmation(s) and needs ${policy.confirmations}; ${policy.confirmations - confirmations} more.`,
      lastCheckedAt: now,
    });
    result.awaiting += 1;
  }

  return result;
}

/** The pending row's own sentence, for a surface that is not running a watcher. */
export function describePendingConfirmations(row: DepositRow, required: number): string {
  const remaining = Math.max(0, required - row.confirmations);
  return remaining === 0
    ? `Waiting to be credited: ${row.confirmations} of ${required} confirmation(s) are in.`
    : `${row.confirmations} of ${required} confirmation(s); ${remaining} more before it is credited.`;
}

export type { ChainReceipt };
