/**
 * Deterministic local development seed.
 *
 * Every row is addressed by a fixed id (or a natural unique key) and written with
 * `upsert`, so running this twice leaves the same state rather than a second copy
 * of it. Every value is obviously local: identifiers carry a `dev-`/`test-`
 * marker, balances are round placeholder numbers, and nothing is copied from a
 * production database. No credential material of any kind is written here.
 *
 * What this seed cannot insert, and why (there is no table for it yet):
 *   - account cash balances and a cash ledger — phases 12/13 add deposits, a
 *     ledger and balances. The funded balance and its transactions therefore live
 *     in the process-local PAPER ledger for now; see
 *     `src/lib/paper-trading/dev-seed.ts` and the README.
 *   - strategy lifecycle rows — strategies are PAPER bots held in a process-local
 *     store, not database rows. Same dev seed, same README section.
 *   - market candles and headlines — those are provider data, not seed data, and
 *     fabricating them would put invented prices on screen.
 */
import { PrismaClient } from "@prisma/client";
import { DEVELOPMENT_OWNER_EVM_ADDRESS, getInitialAdminEvmAddress } from "../src/lib/auth/config";
import { resolveDatabaseUrl } from "../src/lib/database-config";
import { USD_WATCHLIST } from "../src/lib/market-data/watchlist";

const TEST_ACCOUNT_ADDRESS = "0x2222222222222222222222222222222222222222";

/** Chain identity the application stores for an EVM mainnet SIWE identity. */
const CHAIN = { chainNamespace: "eip155", chainReference: "1" } as const;

/** Fixed clock so a reseed produces byte-identical values. */
const SEEDED_AT = new Date("2026-01-01T00:00:00.000Z");

/**
 * The test account's day, in order: a sign-in, a deposit, three trades, a
 * strategy pass, an alert delivery, a withdrawal request and a support ticket.
 * Phase 35's timeline is only meaningful against events that actually happened
 * at different moments, so every seeded row carries one of these fixed times.
 */
const MOMENTS = {
  signIn: new Date("2026-01-01T08:00:00.000Z"),
  deposit: new Date("2026-01-01T09:00:00.000Z"),
  depositCredit: new Date("2026-01-01T09:00:30.000Z"),
  decision: new Date("2026-01-01T10:30:00.000Z"),
  delivery: new Date("2026-01-01T11:00:00.000Z"),
  withdrawal: new Date("2026-01-01T12:00:00.000Z"),
  withdrawalReservation: new Date("2026-01-01T12:00:30.000Z"),
  ticket: new Date("2026-01-01T13:00:00.000Z"),
  ticketInternal: new Date("2026-01-01T13:05:00.000Z"),
  note: new Date("2026-01-01T13:10:00.000Z"),
} as const;

const SEED_DEPOSIT_HASH = `0x${"a".repeat(64)}`;
const SEED_DEPOSIT_BLOCK_HASH = `0x${"b".repeat(64)}`;
const SEED_WITHDRAWAL_ADDRESS = "0x3333333333333333333333333333333333333333";

const IDS = {
  ownerUser: "dev-owner-user",
  ownerWallet: "dev-owner-wallet",
  ownerRole: "dev-owner-role",
  testUser: "dev-test-account",
  testWallet: "dev-test-wallet",
  testRole: "dev-test-role",
  team: "dev-risk-desk",
  membership: "dev-risk-desk-member",
  alertActive: "dev-alert-btc-above",
  alertTriggered: "dev-alert-eth-below",
  alertPaused: "dev-alert-sol-upper",
  alertEvent: "dev-alert-event-eth-below",
  settings: "global",
  ledgerAvailable: "dev-ledger-account-test-usdt-available",
  ledgerReserved: "dev-ledger-account-test-usdt-reserved",
  ledgerTreasury: "dev-ledger-account-treasury-usdt",
  ledgerDepositTx: "dev-ledger-tx-deposit",
  ledgerWithdrawalTx: "dev-ledger-tx-withdrawal",
  ledgerDepositEntry: "dev-ledger-entry-deposit-available",
  ledgerDepositTreasury: "dev-ledger-entry-deposit-treasury",
  ledgerWithdrawalEntry: "dev-ledger-entry-withdrawal-available",
  ledgerWithdrawalReserved: "dev-ledger-entry-withdrawal-reserved",
  deposit: "dev-deposit-seed",
  withdrawal: "dev-withdrawal-seed",
  session: "dev-session-seed",
  strategyActivation: "dev-strategy-activation",
  strategyDecision: "dev-strategy-decision",
  delivery: "dev-delivery-seed",
  ticket: "dev-ticket-latency",
  ticketPublic: "dev-ticket-message-public",
  ticketInternal: "dev-ticket-message-internal",
  userNote: "dev-user-note-watcher",
  savedReply: "dev-saved-reply-deposit",
  auditSupport: "dev-audit-support-ticket-created",
} as const;

const APPROVED_SYMBOLS = USD_WATCHLIST.map(({ productId }) => productId);

const ALERTS = [
  { id: IDS.alertActive, symbol: "BTC-USD", condition: "PRICE_ABOVE", threshold: "250000", status: "ACTIVE", observed: null },
  { id: IDS.alertTriggered, symbol: "ETH-USD", condition: "PRICE_BELOW", threshold: "1000", status: "TRIGGERED", observed: "998.42" },
  { id: IDS.alertPaused, symbol: "SOL-USD", condition: "RSI_14_ABOVE", threshold: "72", status: "PAUSED", observed: null },
] as const;

/**
 * Three local order records: the persisted half of "transactions".
 *
 * Each one sits in a different part of the lifecycle (`CREATED` → `SUBMITTED` →
 * `FILLED`/`FAILED`, see `src/lib/orders/state-machine.ts`), so the paper order
 * panel on `/trade` has one terminal, one live and one failed order to render
 * without anything having to be placed first. The quantities are obvious
 * placeholders and no venue was contacted: `venueOrderId` carries the paper
 * venue's own prefix so nobody mistakes these for a real exchange's orders.
 */
const ORDERS = [
  {
    clientOrderId: "dev-order-0001",
    market: "BTC-USD",
    side: "BUY",
    orderType: "MARKET",
    status: "FILLED",
    requestedAmount: "0.01",
    filledQuantity: "0.01",
    venueOrderId: "paper-dev-order-0001",
    attempts: 1,
    lastAttemptReason: "The paper venue reported the order fully executed.",
    limitPrice: null,
    stopLossPrice: "45000",
    notionalUsdCents: 50_000,
    verifiedBalanceCents: 2_500_000,
    createdAt: new Date("2026-01-01T10:00:00.000Z"),
  },
  {
    clientOrderId: "dev-order-0002",
    market: "ETH-USD",
    side: "BUY",
    orderType: "LIMIT",
    status: "SUBMITTED",
    requestedAmount: "0.5",
    filledQuantity: "0",
    venueOrderId: "paper-dev-order-0002",
    attempts: 1,
    lastAttemptReason: "The paper venue accepted the order and has executed nothing yet.",
    limitPrice: "2400",
    stopLossPrice: "2100",
    notionalUsdCents: 120_000,
    verifiedBalanceCents: 2_500_000,
    createdAt: new Date("2026-01-01T10:20:00.000Z"),
  },
  {
    clientOrderId: "dev-order-0003",
    market: "SOL-USD",
    side: "SELL",
    orderType: "MARKET",
    status: "FAILED",
    requestedAmount: "4",
    filledQuantity: "0",
    venueOrderId: null,
    attempts: 3,
    lastAttemptReason: "The paper venue could not be reached, so the order was failed with its reason rather than retried forever.",
    limitPrice: null,
    stopLossPrice: "150",
    notionalUsdCents: 80_000,
    verifiedBalanceCents: 2_500_000,
    createdAt: new Date("2026-01-01T10:40:00.000Z"),
  },
] as const;

/**
 * The audit chain each seeded order would have written had it been placed here.
 * `previousStatus`/`nextStatus`/`reason` are the same fields
 * `src/lib/orders/store.ts` writes, so the seeded trail is shaped exactly like a
 * live one instead of being a lookalike.
 */
const ORDER_AUDIT_EVENTS = [
  { id: "dev-audit-order-0001-created", action: "ORDER_CREATED", objectId: "dev-order-0001", previousStatus: null, nextStatus: "CREATED", reason: "The order intent was recorded locally (seed)." },
  { id: "dev-audit-order-0001-submitted", action: "ORDER_SUBMITTED", objectId: "dev-order-0001", previousStatus: "CREATED", nextStatus: "SUBMITTED", reason: "Attempt 1 of 3 was sent to dev-paper (seed)." },
  { id: "dev-audit-order-0001-filled", action: "ORDER_FILLED", objectId: "dev-order-0001", previousStatus: "SUBMITTED", nextStatus: "FILLED", reason: "The paper venue reported the order fully executed (seed)." },
  { id: "dev-audit-order-0002-created", action: "ORDER_CREATED", objectId: "dev-order-0002", previousStatus: null, nextStatus: "CREATED", reason: "The order intent was recorded locally (seed)." },
  { id: "dev-audit-order-0002-submitted", action: "ORDER_SUBMITTED", objectId: "dev-order-0002", previousStatus: "CREATED", nextStatus: "SUBMITTED", reason: "The limit price had not been reached, so the paper venue holds the order open (seed)." },
  { id: "dev-audit-order-0003-created", action: "ORDER_CREATED", objectId: "dev-order-0003", previousStatus: null, nextStatus: "CREATED", reason: "The order intent was recorded locally (seed)." },
  { id: "dev-audit-order-0003-submitted", action: "ORDER_SUBMITTED", objectId: "dev-order-0003", previousStatus: "CREATED", nextStatus: "SUBMITTED", reason: "Attempt 1 of 3 was sent to dev-paper (seed)." },
  { id: "dev-audit-order-0003-failed", action: "ORDER_FAILED", objectId: "dev-order-0003", previousStatus: "SUBMITTED", nextStatus: "FAILED", reason: "Attempt 3 of 3 was the last one the retry policy allows, and the venue never answered (seed)." },
] as const;

const AUDIT_EVENTS = [
  { id: "dev-audit-0001", action: "INITIAL_OWNER_BOOTSTRAP", objectType: "RoleAssignment", outcome: "SUCCESS" },
  { id: "dev-audit-0002", action: "RISK_POLICY_UPDATED", objectType: "RiskPolicySettings", outcome: "SUCCESS" },
  { id: "dev-audit-0003", action: "ACCESS_ROLE_ASSIGNED", objectType: "RoleAssignment", outcome: "SUCCESS" },
  { id: "dev-audit-0004", action: "MARKET_ALERT_CREATED", objectType: "MarketAlert", outcome: "SUCCESS" },
  { id: "dev-audit-0005", action: "PAPER_STATE_CHANGED", objectType: "PaperBot", outcome: "SUCCESS" },
] as const;

/**
 * The wallet this seed makes the owner.
 *
 * The same address the sign-in bootstrap grants OWNER to in development, taken
 * from the one place it is written down (`config.ts`) rather than a second
 * constant here — so a local database seeded with no configuration and a fresh
 * sign-in as the documented local address agree about who the owner is.
 */
function ownerAddress(environment: NodeJS.ProcessEnv): string {
  return getInitialAdminEvmAddress(environment) ?? DEVELOPMENT_OWNER_EVM_ADDRESS;
}

async function seedOwner(prisma: PrismaClient, address: string) {
  await prisma.user.upsert({
    where: { id: IDS.ownerUser },
    update: { status: "ACTIVE" },
    create: { id: IDS.ownerUser, status: "ACTIVE", createdAt: SEEDED_AT, updatedAt: SEEDED_AT },
  });

  await prisma.walletIdentity.upsert({
    where: { id: IDS.ownerWallet },
    update: { addressCanonical: address, addressDisplay: address },
    create: {
      id: IDS.ownerWallet,
      userId: IDS.ownerUser,
      ...CHAIN,
      addressCanonical: address,
      addressDisplay: address,
      proofType: "SEED_LOCAL_DEV",
      verifiedAt: SEEDED_AT,
      createdAt: SEEDED_AT,
    },
  });

  await prisma.roleAssignment.upsert({
    where: { id: IDS.ownerRole },
    update: { role: "OWNER", scope: "global", revokedAt: null },
    create: { id: IDS.ownerRole, userId: IDS.ownerUser, role: "OWNER", scope: "global", createdAt: SEEDED_AT },
  });
}

async function seedTestAccount(prisma: PrismaClient) {
  await prisma.user.upsert({
    where: { id: IDS.testUser },
    update: { status: "ACTIVE" },
    create: { id: IDS.testUser, status: "ACTIVE", createdAt: SEEDED_AT, updatedAt: SEEDED_AT },
  });

  await prisma.walletIdentity.upsert({
    where: { id: IDS.testWallet },
    update: { addressCanonical: TEST_ACCOUNT_ADDRESS, addressDisplay: TEST_ACCOUNT_ADDRESS },
    create: {
      id: IDS.testWallet,
      userId: IDS.testUser,
      ...CHAIN,
      addressCanonical: TEST_ACCOUNT_ADDRESS,
      addressDisplay: TEST_ACCOUNT_ADDRESS,
      proofType: "SEED_LOCAL_DEV",
      verifiedAt: SEEDED_AT,
      createdAt: SEEDED_AT,
    },
  });

  await prisma.roleAssignment.upsert({
    where: { id: IDS.testRole },
    update: { role: "TRADER", scope: "global", revokedAt: null },
    create: { id: IDS.testRole, userId: IDS.testUser, role: "TRADER", scope: "global", createdAt: SEEDED_AT },
  });

  await prisma.departmentTeam.upsert({
    where: { id: IDS.team },
    update: { name: "dev risk desk", createdByUserId: IDS.ownerUser },
    create: { id: IDS.team, name: "dev risk desk", slug: "dev-risk-desk", createdByUserId: IDS.ownerUser, createdAt: SEEDED_AT },
  });

  await prisma.teamMembership.upsert({
    where: { id: IDS.membership },
    update: { teamRole: "MEMBER", revokedAt: null },
    create: {
      id: IDS.membership,
      teamId: IDS.team,
      userId: IDS.testUser,
      teamRole: "MEMBER",
      assignedByUserId: IDS.ownerUser,
      createdAt: SEEDED_AT,
    },
  });

  for (const order of ORDERS) {
    await prisma.tradeOrder.upsert({
      where: { clientOrderId: order.clientOrderId },
      update: { ...order, userId: IDS.testUser, venue: "dev-paper", updatedAt: SEEDED_AT },
      create: {
        ...order,
        userId: IDS.testUser,
        venue: "dev-paper",
        // Every seeded order has been sent, so each carries the time it was
        // sent: the reconciliation grace window is measured from it.
        submittedAt: order.createdAt,
        lastAttemptAt: order.createdAt,
        updatedAt: SEEDED_AT,
        redactedResultJson: "{}",
      },
    });
  }

  for (const event of ORDER_AUDIT_EVENTS) {
    await prisma.auditEvent.upsert({
      where: { id: event.id },
      update: { action: event.action, outcome: event.nextStatus === "FAILED" ? "FAILURE" : "SUCCESS" },
      create: {
        id: event.id,
        actorUserId: IDS.testUser,
        action: event.action,
        objectType: "TradeOrder",
        objectId: event.objectId,
        outcome: event.nextStatus === "FAILED" ? "FAILURE" : "SUCCESS",
        redactedJson: JSON.stringify({
          previousStatus: event.previousStatus,
          nextStatus: event.nextStatus,
          reason: event.reason,
          source: "seed",
        }),
        occurredAt: SEEDED_AT,
      },
    });
  }
}

/**
 * Phase 35: the test account's funded, signed-in day and its support history.
 *
 * Every row is addressed by a fixed id and written with `upsert`, like the rest
 * of this seed, so a second run leaves the same timeline rather than a second
 * copy of it. The deposit credits the ledger and the withdrawal reserves against
 * it, which is what makes the console's derived balances reconcile to `/account`
 * rather than showing a number no entry can reproduce.
 *
 * The ticket carries one PUBLIC message and one INTERNAL one, plus a separate
 * user note. That is the data the visibility test is written against: an account
 * reading its own tickets must never receive the internal row.
 */
async function seedSupportAndTimeline(prisma: PrismaClient) {
  // Accounts exist by code, and an earlier phase may have created one with a
  // generated id. Write entries against the row the code resolves to, never a
  // hard-coded id that only a fresh database would have.
  const availableAccount = await prisma.ledgerAccount.upsert({
    where: { code: `user:${IDS.testUser}:USDT:available` },
    update: { asset: "USDT", decimals: 6, userId: IDS.testUser, ownerType: "USER", bucket: "AVAILABLE" },
    create: {
      id: IDS.ledgerAvailable,
      code: `user:${IDS.testUser}:USDT:available`,
      ownerType: "USER",
      bucket: "AVAILABLE",
      asset: "USDT",
      decimals: 6,
      userId: IDS.testUser,
      createdAt: SEEDED_AT,
      updatedAt: SEEDED_AT,
    },
  });
  const reservedAccount = await prisma.ledgerAccount.upsert({
    where: { code: `user:${IDS.testUser}:USDT:withdrawal-reserved` },
    update: { asset: "USDT", decimals: 6, userId: IDS.testUser, ownerType: "USER", bucket: "WITHDRAWALS_RESERVED" },
    create: {
      id: IDS.ledgerReserved,
      code: `user:${IDS.testUser}:USDT:withdrawal-reserved`,
      ownerType: "USER",
      bucket: "WITHDRAWALS_RESERVED",
      asset: "USDT",
      decimals: 6,
      userId: IDS.testUser,
      createdAt: SEEDED_AT,
      updatedAt: SEEDED_AT,
    },
  });
  const treasuryAccount = await prisma.ledgerAccount.upsert({
    where: { code: "platform:treasury:USDT" },
    update: { asset: "USDT", decimals: 6, ownerType: "PLATFORM", bucket: "TREASURY" },
    create: {
      id: IDS.ledgerTreasury,
      code: "platform:treasury:USDT",
      ownerType: "PLATFORM",
      bucket: "TREASURY",
      asset: "USDT",
      decimals: 6,
      createdAt: SEEDED_AT,
      updatedAt: SEEDED_AT,
    },
  });

  const depositTransaction = await prisma.ledgerTransaction.upsert({
    where: { idempotencyKey: "dev-seed:deposit:dev-deposit-seed" },
    update: { memo: "Seeded deposit credit", occurredAt: MOMENTS.depositCredit },
    create: {
      id: IDS.ledgerDepositTx,
      kind: "DEPOSIT_CREDITED",
      idempotencyKey: "dev-seed:deposit:dev-deposit-seed",
      sourceType: "DEPOSIT",
      sourceId: IDS.deposit,
      memo: "Seeded deposit credit",
      occurredAt: MOMENTS.depositCredit,
      createdAt: MOMENTS.depositCredit,
    },
  });
  await prisma.ledgerEntry.upsert({
    where: { transactionId_sequence: { transactionId: depositTransaction.id, sequence: 0 } },
    update: { amountMinor: "25000000", direction: "CREDIT" },
    create: {
      id: IDS.ledgerDepositEntry,
      transactionId: depositTransaction.id,
      accountId: availableAccount.id,
      asset: "USDT",
      direction: "CREDIT",
      amountMinor: "25000000",
      decimals: 6,
      sequence: 0,
      createdAt: MOMENTS.depositCredit,
    },
  });
  await prisma.ledgerEntry.upsert({
    where: { transactionId_sequence: { transactionId: depositTransaction.id, sequence: 1 } },
    update: { amountMinor: "25000000", direction: "DEBIT" },
    create: {
      id: IDS.ledgerDepositTreasury,
      transactionId: depositTransaction.id,
      accountId: treasuryAccount.id,
      asset: "USDT",
      direction: "DEBIT",
      amountMinor: "25000000",
      decimals: 6,
      sequence: 1,
      createdAt: MOMENTS.depositCredit,
    },
  });

  await prisma.deposit.upsert({
    where: { network_txHash_logIndex: { network: "ethereum", txHash: SEED_DEPOSIT_HASH, logIndex: -1 } },
    update: { status: "CREDITED", creditedAt: MOMENTS.depositCredit, confirmations: 12 },
    create: {
      id: IDS.deposit,
      userId: IDS.testUser,
      network: "ethereum",
      chainId: 1,
      tokenSymbol: "USDT",
      decimals: 6,
      amount: "25",
      rawAmount: "25000000",
      txHash: SEED_DEPOSIT_HASH,
      logIndex: -1,
      blockNumber: 19000000,
      blockHash: SEED_DEPOSIT_BLOCK_HASH,
      confirmations: 12,
      status: "CREDITED",
      origin: "SEED",
      observedAt: MOMENTS.deposit,
      creditedAt: MOMENTS.depositCredit,
      updatedAt: MOMENTS.depositCredit,
    },
  });

  const withdrawalTransaction = await prisma.ledgerTransaction.upsert({
    where: { idempotencyKey: "dev-seed:withdrawal:dev-withdrawal-seed" },
    update: { memo: "Seeded withdrawal reservation", occurredAt: MOMENTS.withdrawalReservation },
    create: {
      id: IDS.ledgerWithdrawalTx,
      kind: "WITHDRAWAL_RESERVED",
      idempotencyKey: "dev-seed:withdrawal:dev-withdrawal-seed",
      sourceType: "WITHDRAWAL",
      sourceId: IDS.withdrawal,
      memo: "Seeded withdrawal reservation",
      occurredAt: MOMENTS.withdrawalReservation,
      createdAt: MOMENTS.withdrawalReservation,
    },
  });
  await prisma.ledgerEntry.upsert({
    where: { transactionId_sequence: { transactionId: withdrawalTransaction.id, sequence: 0 } },
    update: { amountMinor: "5000000", direction: "DEBIT" },
    create: {
      id: IDS.ledgerWithdrawalEntry,
      transactionId: withdrawalTransaction.id,
      accountId: availableAccount.id,
      asset: "USDT",
      direction: "DEBIT",
      amountMinor: "5000000",
      decimals: 6,
      sequence: 0,
      createdAt: MOMENTS.withdrawalReservation,
    },
  });
  await prisma.ledgerEntry.upsert({
    where: { transactionId_sequence: { transactionId: withdrawalTransaction.id, sequence: 1 } },
    update: { amountMinor: "5000000", direction: "CREDIT" },
    create: {
      id: IDS.ledgerWithdrawalReserved,
      transactionId: withdrawalTransaction.id,
      accountId: reservedAccount.id,
      asset: "USDT",
      direction: "CREDIT",
      amountMinor: "5000000",
      decimals: 6,
      sequence: 1,
      createdAt: MOMENTS.withdrawalReservation,
    },
  });

  await prisma.withdrawal.upsert({
    where: { idempotencyKey: "dev-seed:withdrawal:dev-withdrawal-seed" },
    update: { status: "QUEUED" },
    create: {
      id: IDS.withdrawal,
      userId: IDS.testUser,
      network: "ethereum",
      chainId: 1,
      asset: "USDT",
      decimals: 6,
      amountMinor: "5000000",
      feeMinor: "0",
      netMinor: "5000000",
      destination: SEED_WITHDRAWAL_ADDRESS,
      destinationDisplay: SEED_WITHDRAWAL_ADDRESS,
      status: "QUEUED",
      reasonMessage: "Seeded request, waiting for the next broadcast pass.",
      idempotencyKey: "dev-seed:withdrawal:dev-withdrawal-seed",
      expiresAt: new Date("2026-01-02T12:00:00.000Z"),
      createdAt: MOMENTS.withdrawal,
      updatedAt: MOMENTS.withdrawal,
    },
  });

  await prisma.authSession.upsert({
    where: { id: IDS.session },
    update: { revokedAt: null, revokedReason: null },
    create: {
      id: IDS.session,
      userId: IDS.testUser,
      walletIdentityId: IDS.testWallet,
      chainNamespace: CHAIN.chainNamespace,
      chainReference: CHAIN.chainReference,
      deviceLabel: "MetaMask · Chrome on Linux",
      userAgent: "seeded local development session",
      createdAt: MOMENTS.signIn,
      lastSeenAt: MOMENTS.ticket,
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
    },
  });

  const activation = await prisma.strategyActivation.upsert({
    where: { userId: IDS.testUser },
    update: { status: "RUNNING", strategyId: "rsi-daily-close" },
    create: {
      id: IDS.strategyActivation,
      userId: IDS.testUser,
      status: "RUNNING",
      strategyId: "rsi-daily-close",
      startedAt: MOMENTS.decision,
      lastEvaluatedAt: MOMENTS.decision,
      lastOutcome: "NO_ACTION",
      lastReasonCode: "RSI_ABOVE_ENTRY",
      lastReasonMessage: "RSI-14 on the closed daily candle is 48.2, above the 30 entry threshold.",
      runCount: 1,
      lastWindowStart: MOMENTS.decision,
      createdAt: MOMENTS.decision,
      updatedAt: MOMENTS.decision,
    },
  });
  await prisma.strategyDecision.upsert({
    where: { activationId_windowStart: { activationId: activation.id, windowStart: MOMENTS.decision } },
    update: { reasonMessage: "RSI-14 on the closed daily candle is 48.2, above the 30 entry threshold." },
    create: {
      id: IDS.strategyDecision,
      activationId: activation.id,
      userId: IDS.testUser,
      strategyId: "rsi-daily-close",
      windowStart: MOMENTS.decision,
      evaluatedAt: MOMENTS.decision,
      outcome: "NO_ACTION",
      reasonCode: "RSI_ABOVE_ENTRY",
      reasonMessage: "RSI-14 on the closed daily candle is 48.2, above the 30 entry threshold.",
      market: "BTC-USD",
      inputsJson: JSON.stringify({ rsi: "48.2", close: "108450.25" }),
      conditionsJson: JSON.stringify([{ entered: false, value: "48.2", threshold: "30" }]),
      createdAt: MOMENTS.decision,
    },
  });

  await prisma.supportTicket.upsert({
    where: { id: IDS.ticket },
    update: { status: "OPEN", priority: "HIGH", lastMessageAt: MOMENTS.ticketInternal },
    create: {
      id: IDS.ticket,
      userId: IDS.testUser,
      subject: "Deposit did not arrive",
      status: "OPEN",
      priority: "HIGH",
      assigneeUserId: IDS.ownerUser,
      relatedType: "deposit",
      relatedId: IDS.deposit,
      createdByUserId: IDS.ownerUser,
      createdAt: MOMENTS.ticket,
      updatedAt: MOMENTS.ticketInternal,
      lastMessageAt: MOMENTS.ticketInternal,
    },
  });
  await prisma.ticketMessage.upsert({
    where: { id: IDS.ticketPublic },
    update: { body: "My 25 USDT deposit is not showing on the account. Here is the transaction: " + SEED_DEPOSIT_HASH },
    create: {
      id: IDS.ticketPublic,
      ticketId: IDS.ticket,
      authorType: "USER",
      authorUserId: IDS.testUser,
      visibility: "PUBLIC",
      body: "My 25 USDT deposit is not showing on the account. Here is the transaction: " + SEED_DEPOSIT_HASH,
      createdAt: MOMENTS.ticket,
    },
  });
  await prisma.ticketMessage.upsert({
    where: { id: IDS.ticketInternal },
    update: { body: "Watcher lag: the deposit is CREDITED in the ledger, so the balance is right even if the panel looked stale." },
    create: {
      id: IDS.ticketInternal,
      ticketId: IDS.ticket,
      authorType: "STAFF",
      authorUserId: IDS.ownerUser,
      visibility: "INTERNAL",
      body: "Watcher lag: the deposit is CREDITED in the ledger, so the balance is right even if the panel looked stale.",
      createdAt: MOMENTS.ticketInternal,
    },
  });
  await prisma.userNote.upsert({
    where: { id: IDS.userNote },
    update: { body: "Known watcher lag after a provider reconnect; the ledger is authoritative." },
    create: {
      id: IDS.userNote,
      userId: IDS.testUser,
      authorUserId: IDS.ownerUser,
      body: "Known watcher lag after a provider reconnect; the ledger is authoritative.",
      createdAt: MOMENTS.note,
    },
  });
  await prisma.savedReply.upsert({
    where: { name: "Deposit confirmed" },
    update: { body: "Hi {{user.label}}, {{account.summary}} is on your account and the deposit is credited. Ticket {{ticket.id}} is resolved. — {{operator.label}}" },
    create: {
      id: IDS.savedReply,
      name: "Deposit confirmed",
      body: "Hi {{user.label}}, {{account.summary}} is on your account and the deposit is credited. Ticket {{ticket.id}} is resolved. — {{operator.label}}",
      createdByUserId: IDS.ownerUser,
      createdAt: MOMENTS.ticket,
      updatedAt: MOMENTS.ticket,
    },
  });
  await prisma.auditEvent.upsert({
    where: { id: IDS.auditSupport },
    update: { outcome: "SUCCESS" },
    create: {
      id: IDS.auditSupport,
      actorUserId: IDS.ownerUser,
      action: "SUPPORT_TICKET_CREATED",
      objectType: "SupportTicket",
      objectId: IDS.ticket,
      outcome: "SUCCESS",
      occurredAt: MOMENTS.ticket,
      redactedJson: JSON.stringify({
        actor: { type: "User", id: IDS.ownerUser },
        target: { type: "User", id: IDS.testUser },
        subject: "Deposit did not arrive",
        priority: "HIGH",
        related: { type: "deposit", id: IDS.deposit },
      }),
    },
  });
}

async function seedSettings(prisma: PrismaClient) {
  await prisma.riskPolicySettings.upsert({
    where: { id: IDS.settings },
    update: { updatedByUserId: IDS.ownerUser },
    create: {
      id: IDS.settings,
      maxRiskPerTradePercent: "1",
      maxOpenExposurePercent: "25",
      dailyLossHaltPercent: "2",
      maxTradesPerDay: 10,
      defaultMaxLeverage: "1",
      minimumVerifiedBalanceUsd: "20",
      first24HourExposureUsd: "20",
      approvedSymbolsJson: JSON.stringify(APPROVED_SYMBOLS),
      killSwitchActive: false,
      updatedByUserId: IDS.ownerUser,
      updatedAt: SEEDED_AT,
    },
  });

  await prisma.chainGPTFeatureSettings.upsert({
    where: { id: IDS.settings },
    update: { updatedByUserId: IDS.ownerUser },
    create: { id: IDS.settings, updatedByUserId: IDS.ownerUser, updatedAt: SEEDED_AT },
  });

  await prisma.wunderTradingFeatureSettings.upsert({
    where: { id: IDS.settings },
    update: { updatedByUserId: IDS.ownerUser },
    create: { id: IDS.settings, updatedByUserId: IDS.ownerUser, updatedAt: SEEDED_AT },
  });

  await prisma.integrationFeatureSettings.upsert({
    where: { id: IDS.settings },
    update: { updatedByUserId: IDS.ownerUser },
    create: { id: IDS.settings, updatedByUserId: IDS.ownerUser, updatedAt: SEEDED_AT },
  });

  // The security policy is seeded with every scope **off**, and no authenticator
  // is enrolled here at all. That is deliberate: a seeded secret would be a
  // secret in the repository, and a scope on by default would be a requirement
  // the owner never asked for. Phase 10 adds no requirement the owner cannot
  // turn off, so the seeded state is "nothing is demanded yet".
  await prisma.securityPolicySettings.upsert({
    where: { id: IDS.settings },
    update: { updatedByUserId: IDS.ownerUser },
    create: { id: IDS.settings, updatedByUserId: IDS.ownerUser, updatedAt: SEEDED_AT },
  });
}

async function seedAlertsAndAudit(prisma: PrismaClient) {
  for (const alert of ALERTS) {
    const data = {
      userId: IDS.testUser,
      symbol: alert.symbol,
      condition: alert.condition,
      threshold: alert.threshold,
      status: alert.status,
      lastObservedValue: alert.observed,
      lastEvaluatedAt: SEEDED_AT,
      triggeredAt: alert.status === "TRIGGERED" ? SEEDED_AT : null,
    };
    await prisma.marketAlert.upsert({
      where: { id: alert.id },
      update: data,
      create: { id: alert.id, ...data, createdAt: SEEDED_AT, updatedAt: SEEDED_AT },
    });
  }

  // The delivery points at a seeded alert, so it has to be written after the
  // alerts exist — on a fresh database the foreign key would otherwise fail.
  await prisma.notificationDelivery.upsert({
    where: { dedupeKey_channel_attempt: { dedupeKey: "dev-seed:alert-btc", channel: "EMAIL", attempt: 1 } },
    update: { status: "DELIVERED" },
    create: {
      id: IDS.delivery,
      userId: IDS.testUser,
      alertId: IDS.alertActive,
      channel: "EMAIL",
      target: "dev-test@example.invalid",
      subject: "BTC-USD is above 250000",
      body: "The seeded alert crossed its threshold at 250100.00.",
      status: "DELIVERED",
      providerId: "dev-email",
      attempt: 1,
      durationMs: 42,
      dedupeKey: "dev-seed:alert-btc",
      windowStart: MOMENTS.delivery,
      queuedAt: MOMENTS.delivery,
      deliveredAt: MOMENTS.delivery,
      createdAt: MOMENTS.delivery,
    },
  });

  await prisma.marketAlertEvent.upsert({
    where: { id: IDS.alertEvent },
    update: {},
    create: {
      id: IDS.alertEvent,
      alertId: IDS.alertTriggered,
      actorUserId: IDS.testUser,
      observedValue: "998.42",
      sourceObservedAt: SEEDED_AT,
      providerId: "dev-paper-feed",
      triggeredAt: SEEDED_AT,
    },
  });

  for (const event of AUDIT_EVENTS) {
    // The audit log keeps storing redacted payloads, exactly as production does.
    await prisma.auditEvent.upsert({
      where: { id: event.id },
      update: { outcome: event.outcome },
      create: {
        id: event.id,
        actorUserId: event.action === "MARKET_ALERT_CREATED" ? IDS.testUser : IDS.ownerUser,
        action: event.action,
        objectType: event.objectType,
        objectId: `dev-${event.action.toLowerCase()}`,
        outcome: event.outcome,
        occurredAt: SEEDED_AT,
        redactedJson: "{}",
      },
    });
  }
}

async function summarise(prisma: PrismaClient) {
  const [
    users,
    walletIdentities,
    roleAssignments,
    teams,
    teamMemberships,
    riskPolicySettings,
    chainGptSettings,
    wunderTradingSettings,
    securityPolicySettings,
    integrationSettings,
    marketAlerts,
    marketAlertEvents,
    auditEvents,
    tradeOrders,
    supportTickets,
    ticketMessages,
    userNotes,
    savedReplies,
    deposits,
  ] = await prisma.$transaction([
    prisma.user.count(),
    prisma.walletIdentity.count(),
    prisma.roleAssignment.count(),
    prisma.departmentTeam.count(),
    prisma.teamMembership.count(),
    prisma.riskPolicySettings.count(),
    prisma.chainGPTFeatureSettings.count(),
    prisma.wunderTradingFeatureSettings.count(),
    prisma.integrationFeatureSettings.count(),
    prisma.securityPolicySettings.count(),
    prisma.marketAlert.count(),
    prisma.marketAlertEvent.count(),
    prisma.auditEvent.count(),
    prisma.tradeOrder.count(),
    prisma.supportTicket.count(),
    prisma.ticketMessage.count(),
    prisma.userNote.count(),
    prisma.savedReply.count(),
    prisma.deposit.count(),
  ]);

  return {
    users,
    walletIdentities,
    roleAssignments,
    teams,
    teamMemberships,
    riskPolicySettings,
    chainGPTFeatureSettings: chainGptSettings,
    wunderTradingFeatureSettings: wunderTradingSettings,
    securityPolicySettings,
    integrationFeatureSettings: integrationSettings,
    marketAlerts,
    marketAlertEvents,
    auditEvents,
    tradeOrders,
    supportTickets,
    ticketMessages,
    userNotes,
    savedReplies,
    deposits,
  };
}

async function main() {
  const url = resolveDatabaseUrl();
  if (!url || !url.startsWith("file:")) {
    console.error(
      "The seed only runs against the local SQLite development database. " +
        `It resolved ${url ? "a non-file database URL" : "no database URL"}.`,
    );
    process.exit(2);
  }

  const prisma = new PrismaClient({ datasourceUrl: url });
  const address = ownerAddress(process.env);
  try {
    await seedOwner(prisma, address);
    await seedTestAccount(prisma);
    await seedSupportAndTimeline(prisma);
    await seedSettings(prisma);
    await seedAlertsAndAudit(prisma);
    const counts = await summarise(prisma);
    console.log(`Seeded the local development database (owner ${address}).`);
    for (const [table, count] of Object.entries(counts)) {
      console.log(`  ${table.padEnd(30)} ${count}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
