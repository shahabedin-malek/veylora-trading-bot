#!/usr/bin/env node
/**
 * The performance bench (phase 38).
 *
 * It answers one question with numbers: with a realistic amount of history, how
 * long do the surfaces people use actually take?
 *
 * The bench never touches the development database. It copies the seeded
 * `prisma/dev.db` to `prisma/bench.db`, adds volume to the copy, starts the
 * production build against that file, mints a session for the seeded owner, and
 * measures HTTP responses. That is deliberate: a benchmark against a mutated
 * `dev.db` would leave the owner's own database changed, and a benchmark against
 * an empty one is a number about nothing — so the volume it used is printed with
 * every result and stored in the JSON.
 *
 * Usage:
 *   node scripts/bench.mjs                       # standard volume, "current" label
 *   node scripts/bench.mjs --label before        # store a named run
 *   node scripts/bench.mjs --volume empty        # the failure case: no history
 *   node scripts/bench.mjs --indexes without     # drop this phase's indexes and measure again
 *   node scripts/bench.mjs --heap 192            # a smaller V8 heap: the exports must still complete
 *   node scripts/bench.mjs --keep                # keep the server and bench.db running
 *   node scripts/bench.mjs --compare before after # print the delta between two runs
 *
 * Results are written to `proof/bench/phase38-<label>.json` and printed as a table.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpsServer } from "node:https";
import { request as httpRequest } from "node:http";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveDevSchema } from "./dev-database.mjs";

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_DIR = resolve(APP_DIR, "../..");
const PRISMA_DIR = join(APP_DIR, "prisma");
const DEV_DB = join(PRISMA_DIR, "dev.db");
const BENCH_DB = join(PRISMA_DIR, "bench.db");
const CERT_DIR = join(APP_DIR, ".bench-cert");
const OUTPUT_DIR = join(REPO_DIR, "proof/bench");

const STANDARD_VOLUME = {
  ledgerEntries: 100_000,
  auditEvents: 50_000,
  orders: 20_000,
  decisions: 20_000,
  strategies: 25,
  candlesPerMarket: 120,
};

/**
 * The indexes this phase adds, by the names Prisma gives them on SQLite, so the
 * "without" run can drop exactly these and nothing else. Each one is justified by
 * a measured difference in `proof/phase-38-performance-and-load.md`.
 */
const PHASE_38_INDEXES = [
  "LedgerTransaction_occurredAt_idx",
  "LedgerEntry_accountId_transactionId_idx",
  "TradeOrder_userId_status_createdAt_idx",
  "TradeOrder_userId_market_status_idx",
];

/**
 * The server's heap cap. An export that only "works" because the machine has 32 GB
 * is not the property the phase asks for: 512 MB is a small production instance's
 * budget, and `--heap` lowers it further to prove the export streams rather than
 * accumulates.
 */
function serverOptions() {
  return { ...PRODUCTION_ENV, NODE_OPTIONS: `--max-old-space-size=${process.env.BENCH_HEAP_MB ?? 512}` };
}

const MARKETS = ["BTC-USD", "ETH-USD", "SOL-USD", "XRP-USD", "DOGE-USD", "ADA-USD"];
const PRODUCTION_ENV = {
  NODE_ENV: "production",
  SESSION_SECRET: "bench-session-secret-that-is-long-enough-0123456789",
  AUTH_EVM_CHAIN_IDS: "1",
  CRON_SECRET: "bench-cron-secret",
  APP_BASE_URL: "https://localhost:3443",
  DATABASE_URL: "file:./bench.db",
  DATABASE_URL_UNPOOLED: "file:./bench.db",
  veylora_DATABASE_URL: "file:./bench.db",
  VEYLORA_PRISMA_QUIET: "1",
  BENCH_PORT: "3411",
  BENCH_TLS_PORT: "3443",
};

function parseArguments(argv) {
  const options = {
    label: "current",
    volume: "standard",
    indexes: "with",
    keep: false,
    compare: null,
    samples: 5,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const [name, inline] = argument.split("=");
    const value = inline ?? argv[index + 1];
    switch (name) {
      case "--label":
        options.label = value;
        if (inline === undefined) index += 1;
        break;
      case "--volume":
        options.volume = value;
        if (inline === undefined) index += 1;
        break;
      case "--indexes":
        options.indexes = value;
        if (inline === undefined) index += 1;
        break;
      case "--samples":
        options.samples = Number(value);
        if (inline === undefined) index += 1;
        break;
      case "--heap":
        process.env.BENCH_HEAP_MB = value;
        if (inline === undefined) index += 1;
        break;
      case "--keep":
        options.keep = true;
        break;
      case "--compare":
        options.compare = [value, argv[index + 2]].filter(Boolean);
        break;
      case "--help":
        console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0]);
        process.exit(0);
        break;
      default:
        break;
    }
  }
  return options;
}

function log(message) {
  process.stdout.write(`${message}\n`);
}

function fail(message) {
  process.stderr.write(`bench: ${message}\n`);
  process.exit(1);
}

function nowMs() {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

async function timeIt(work) {
  const started = nowMs();
  const value = await work();
  return { value, ms: nowMs() - started };
}

async function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function ensureRuntime() {
  if (!existsSync(DEV_DB)) {
    fail("no prisma/dev.db to copy. Run `pnpm db:setup` first, then re-run the bench.");
  }
  mkdirSync(OUTPUT_DIR, { recursive: true });
}

function resetBenchDatabase() {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(`${BENCH_DB}${suffix}`)) rmSync(`${BENCH_DB}${suffix}`, { force: true });
  }
  copyFileSync(DEV_DB, BENCH_DB);
}

/**
 * Apply the current schema to the copy, so a new index exists before it is measured.
 *
 * The SQLite schema is derived from the Postgres one by the same function
 * `db:setup` uses, so an index added to `schema.prisma` is in the copy without a
 * second hand-maintained copy of the models existing for the bench.
 */
function pushSchema() {
  const derived = deriveDevSchema(readFileSync(join(PRISMA_DIR, "schema.prisma"), "utf8"));
  writeFileSync(join(PRISMA_DIR, "schema.dev.prisma"), derived, "utf8");
  const result = spawnSync(join(APP_DIR, "node_modules", ".bin", "prisma"), ["db", "push", "--schema", join(PRISMA_DIR, "schema.dev.prisma"), "--skip-generate"], {
    cwd: APP_DIR,
    env: { ...process.env, ...PRODUCTION_ENV },
    stdio: "inherit",
  });
  if (result.status !== 0) fail(`prisma db push exited ${result.status}; the bench database has no schema.`);
}

async function openClient() {
  const { PrismaClient } = await import("@prisma/client");
  return new PrismaClient({ datasourceUrl: "file:./bench.db", log: [] });
}

function rowsOf(count) {
  return Array.from({ length: count }, (_, index) => index);
}

/** 50,000 balanced transactions = 100,000 entries, spread over the last 400 days. */
async function seedLedger(prisma, volume) {
  const user = await prisma.user.findUnique({ where: { id: "dev-owner-user" }, select: { id: true } });
  if (!user) fail("the copied database has no dev-owner-user; run `pnpm db:seed` first.");
  const asset = { asset: "USDT", decimals: 6 };
  const userAccount = await prisma.ledgerAccount.upsert({
    where: { code: `user:${user.id}:${asset.asset}:available` },
    update: {},
    create: {
      code: `user:${user.id}:${asset.asset}:available`,
      ownerType: "USER",
      bucket: "AVAILABLE",
      asset: asset.asset,
      decimals: asset.decimals,
      userId: user.id,
    },
  });
  const platformAccount = await prisma.ledgerAccount.upsert({
    where: { code: `platform:treasury:${asset.asset}` },
    update: {},
    create: {
      code: `platform:treasury:${asset.asset}`,
      ownerType: "PLATFORM",
      bucket: "TREASURY",
      asset: asset.asset,
      decimals: asset.decimals,
    },
  });

  const transactions = Math.floor(volume.ledgerEntries / 2);
  const startedAt = Date.now() - 400 * 24 * 60 * 60 * 1000;
  const batchSize = 5_000;
  for (let offset = 0; offset < transactions; offset += batchSize) {
    const indexes = rowsOf(Math.min(batchSize, transactions - offset)).map((row) => offset + row);
    await prisma.ledgerTransaction.createMany({
      data: indexes.map((index) => ({
        id: `bench-tx-${String(index).padStart(7, "0")}`,
        kind: "BENCH_MOVEMENT",
        idempotencyKey: `bench:movement:${index}`,
        occurredAt: new Date(startedAt + Math.floor((index / transactions) * 400 * 24 * 60 * 60 * 1000)),
        memo: "Bench volume.",
      })),
    });
    await prisma.ledgerEntry.createMany({
      data: indexes.flatMap((index) => {
        const amount = String(1_000 + (index % 10_000));
        const transactionId = `bench-tx-${String(index).padStart(7, "0")}`;
        return [
          { id: `bench-entry-${String(index * 2).padStart(7, "0")}`, transactionId, accountId: platformAccount.id, asset: asset.asset, direction: "DEBIT", amountMinor: amount, decimals: asset.decimals, sequence: 1 },
          { id: `bench-entry-${String(index * 2 + 1).padStart(7, "0")}`, transactionId, accountId: userAccount.id, asset: asset.asset, direction: "CREDIT", amountMinor: amount, decimals: asset.decimals, sequence: 2 },
        ];
      }),
    });
  }
  return { userAccountId: userAccount.id, platformAccountId: platformAccount.id };
}

async function seedAudit(prisma, volume) {
  const actions = ["ORDER_CREATED", "ORDER_FILLED", "DEPOSIT_CREDITED", "WITHDRAWAL_REQUESTED", "ACCESS_ROLE_ASSIGNED", "RISK_POLICY_UPDATED", "STRATEGY_DECISION"];
  const sources = ["api", "runner", "admin"];
  const startedAt = Date.now() - 400 * 24 * 60 * 60 * 1000;
  const batchSize = 5_000;
  for (let offset = 0; offset < volume.auditEvents; offset += batchSize) {
    const indexes = rowsOf(Math.min(batchSize, volume.auditEvents - offset)).map((row) => offset + row);
    await prisma.auditEvent.createMany({
      data: indexes.map((index) => ({
        id: `bench-audit-${String(index).padStart(7, "0")}`,
        actorUserId: "dev-owner-user",
        action: actions[index % actions.length],
        objectType: "BenchRecord",
        objectId: `bench-object-${index % 5_000}`,
        occurredAt: new Date(startedAt + Math.floor((index / volume.auditEvents) * 400 * 24 * 60 * 60 * 1000)),
        outcome: "SUCCESS",
        source: sources[index % sources.length],
        redactedJson: JSON.stringify({ bench: true, index }),
      })),
    });
  }
}

async function seedOrders(prisma, volume, strategyUserIds) {
  const statuses = ["FILLED", "FILLED", "FILLED", "CANCELLED", "SUBMITTED", "PARTIALLY_FILLED"];
  const startedAt = Date.now() - 400 * 24 * 60 * 60 * 1000;
  const owners = ["dev-owner-user", "dev-owner-user", "dev-test-account", ...strategyUserIds];
  const batchSize = 2_000;
  for (let offset = 0; offset < volume.orders; offset += batchSize) {
    const indexes = rowsOf(Math.min(batchSize, volume.orders - offset)).map((row) => offset + row);
    await prisma.tradeOrder.createMany({
      data: indexes.map((index) => ({
        id: `bench-order-${String(index).padStart(7, "0")}`,
        userId: owners[index % owners.length],
        venue: "dev-paper",
        market: MARKETS[index % MARKETS.length],
        side: index % 2 === 0 ? "BUY" : "SELL",
        orderType: "MARKET",
        status: statuses[index % statuses.length],
        clientOrderId: `bench-client-${index}`,
        requestedAmount: "10",
        filledQuantity: "10",
        stopLossPrice: "0",
        notionalUsdCents: 1_000,
        verifiedBalanceCents: 10_000,
        createdAt: new Date(startedAt + Math.floor((index / volume.orders) * 400 * 24 * 60 * 60 * 1000)),
      })),
    });
  }
}

/** 25 accounts, each running the built-in strategy, with the candles it reads. */
async function seedStrategies(prisma, volume) {
  const userIds = [];
  const activationIds = [];
  for (const index of rowsOf(volume.strategies)) {
    const userId = `bench-strategy-user-${index}`;
    const activationId = `bench-activation-${index}`;
    userIds.push(userId);
    activationIds.push(activationId);
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId, status: "ACTIVE" } });
    await prisma.strategyActivation.upsert({
      where: { id: activationId },
      update: { status: "RUNNING", strategyId: "rsi-daily-close" },
      create: {
        id: activationId,
        userId,
        status: "RUNNING",
        strategyId: "rsi-daily-close",
        startedAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
        lastChangeReason: "Bench volume.",
      },
    });
  }

  const day = 24 * 60 * 60 * 1000;
  const start = Date.now() - volume.candlesPerMarket * day;
  for (const symbol of MARKETS) {
    await prisma.marketCandleRecord.createMany({
      data: rowsOf(volume.candlesPerMarket).map((index) => {
        const open = 40_000 + index * 10 + (index % 7) * 25;
        return {
          id: `bench-candle-${symbol}-${index}`,
          providerId: "coinbase",
          symbol,
          interval: "1d",
          openTime: new Date(start + index * day),
          closeTime: new Date(start + (index + 1) * day - 1),
          open: String(open),
          high: String(open + 200),
          low: String(open - 200),
          close: String(open + 50),
          volume: "100",
          fetchedAt: new Date(),
          freshness: "FRESH",
        };
      }),
    });
  }
  return { userIds, activationIds };
}

async function seedDecisions(prisma, volume, activationIds) {
  const startedAt = Date.now() - 400 * 24 * 60 * 60 * 1000;
  const outcomes = ["NO_ACTION", "NO_ACTION", "ORDER_PLACED", "ERROR"];
  const batchSize = 5_000;
  for (let offset = 0; offset < volume.decisions; offset += batchSize) {
    const indexes = rowsOf(Math.min(batchSize, volume.decisions - offset)).map((row) => offset + row);
    await prisma.strategyDecision.createMany({
      data: indexes.map((index) => {
        const activationIndex = index % activationIds.length;
        return {
          id: `bench-decision-${String(index).padStart(7, "0")}`,
          activationId: activationIds[activationIndex],
          userId: `bench-strategy-user-${activationIndex}`,
          strategyId: "rsi-daily-close",
          // One window per index keeps the unique (activation, window) constraint satisfied.
          windowStart: new Date(startedAt + Math.floor((index / volume.decisions) * 400 * 24 * 60 * 60 * 1000)),
          evaluatedAt: new Date(startedAt + Math.floor((index / volume.decisions) * 400 * 24 * 60 * 60 * 1000)),
          outcome: outcomes[index % outcomes.length],
          reasonCode: outcomes[index % outcomes.length] === "ORDER_PLACED" ? "ENTRY_CONDITION_MET" : "NO_ENTRY_CONDITION",
          reasonMessage: "Bench volume.",
          market: "BTC-USD",
        };
      }),
    });
  }
}

async function seedVolume(prisma, volume) {
  log(`bench: seeding volume (${volume.ledgerEntries} ledger entries, ${volume.auditEvents} audit events, ${volume.orders} orders, ${volume.decisions} decisions, ${volume.strategies} strategies)…`);
  const ledger = await seedLedger(prisma, volume);
  await seedAudit(prisma, volume);
  const strategies = await seedStrategies(prisma, volume);
  await seedOrders(prisma, volume, strategies.userIds);
  await seedDecisions(prisma, volume, strategies.activationIds);
  return { ...ledger, ...strategies };
}

async function seedEmpty(prisma) {
  const user = await prisma.user.findUnique({ where: { id: "dev-owner-user" }, select: { id: true } });
  if (!user) fail("the copied database has no dev-owner-user; run `pnpm db:seed` first.");
  const userAccount = await prisma.ledgerAccount.findUnique({ where: { code: `user:${user.id}:USDT:available` } });
  return { userAccountId: userAccount?.id ?? null };
}

async function dropPhaseIndexes(prisma) {
  for (const name of PHASE_38_INDEXES) {
    await prisma.$executeRawUnsafe(`DROP INDEX IF EXISTS "${name}"`).catch(() => null);
  }
}

function countVolume(prisma) {
  return Promise.all([
    prisma.ledgerEntry.count(),
    prisma.auditEvent.count(),
    prisma.tradeOrder.count(),
    prisma.strategyDecision.count(),
    prisma.strategyActivation.count({ where: { status: "RUNNING" } }),
  ]).then(([ledgerEntries, auditEvents, orders, decisions, runningStrategies]) => ({
    ledgerEntries,
    auditEvents,
    orders,
    decisions,
    runningStrategies,
  }));
}

/** The server process's resident memory, so an export's memory cost is a number. */
function readServerRssKb(pid) {
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const match = /^VmRSS:\s+(\d+) kB/m.exec(status);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

function generateCertificate() {
  mkdirSync(CERT_DIR, { recursive: true });
  const keyPath = join(CERT_DIR, "key.pem");
  const certPath = join(CERT_DIR, "cert.pem");
  if (existsSync(keyPath) && existsSync(certPath)) return { keyPath, certPath };
  const result = spawnSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", "/CN=localhost",
    "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
    "-keyout", keyPath, "-out", certPath,
  ], { stdio: "ignore" });
  if (result.status !== 0 || !existsSync(certPath)) fail("openssl could not generate the bench certificate.");
  return { keyPath, certPath };
}

/**
 * The production build refuses an http origin in production (`secureCookies`),
 * so the measurement goes through a loopback TLS terminator. The bench client
 * trusts that one certificate by disabling verification for its own requests;
 * nothing else on the machine does.
 */
function startTlsProxy() {
  const { keyPath, certPath } = generateCertificate();
  return new Promise((resolveProxy) => {
    const proxy = createHttpsServer({ key: readFileSync(keyPath), cert: readFileSync(certPath) }, (request, response) => {
      const upstream = httpRequest(
        {
          host: "127.0.0.1",
          port: Number(PRODUCTION_ENV.BENCH_PORT),
          path: request.url,
          method: request.method,
          headers: { ...request.headers, host: `localhost:${PRODUCTION_ENV.BENCH_PORT}` },
        },
        (upstreamResponse) => {
          response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
          upstreamResponse.pipe(response);
        },
      );
      upstream.on("error", () => {
        response.writeHead(502, { "content-type": "text/plain" });
        response.end("bench TLS proxy could not reach the app.");
      });
      request.pipe(upstream);
    });
    proxy.listen(Number(PRODUCTION_ENV.BENCH_TLS_PORT), "127.0.0.1", () => resolveProxy(proxy));
  });
}

async function waitForApp() {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`https://localhost:${PRODUCTION_ENV.BENCH_TLS_PORT}/api/auth/config`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.status < 500) return;
    } catch {
      // Not up yet.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  fail("the app did not answer on the bench origin within 120 seconds.");
}

function mintSession(prisma, secret) {
  const sessionId = randomBytes(16).toString("hex");
  const walletIdentityId = "dev-owner-wallet";
  const expiresAt = Math.floor(Date.now() / 1000) + 60 * 60;
  return (async () => {
    const user = await prisma.user.findUnique({ where: { id: "dev-owner-user" }, select: { sessionVersion: true, status: true } });
    if (!user || user.status !== "ACTIVE") fail("dev-owner-user is not an active account in the copied database.");
    await prisma.authSession.create({
      data: {
        id: sessionId,
        userId: "dev-owner-user",
        walletIdentityId,
        chainNamespace: "eip155",
        chainReference: "1",
        deviceLabel: "Bench",
        expiresAt: new Date(expiresAt * 1000),
      },
    });
    const claims = {
      userId: "dev-owner-user",
      walletIdentityId,
      sessionId,
      chainNamespace: "eip155",
      chainReference: "1",
      sessionVersion: user.sessionVersion,
      issuedAt: Math.floor(Date.now() / 1000),
      expiresAt,
    };
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const signature = createHmac("sha256", secret).update(payload).digest("base64url");
    return `veylora_session=${payload}.${signature}`;
  })();
}

async function measureHttp(baseUrl, cookie, sampleCount, paths) {
  const results = [];
  for (const path of paths) {
    // Warm-up: a cold route is a compile-time fact, not a steady-state one.
    const warm = await fetch(`${baseUrl}${path}`, { headers: { cookie }, redirect: "manual" });
    const status = warm.status;
    await warm.arrayBuffer();
    const samples = [];
    let bytes = 0;
    for (let index = 0; index < sampleCount; index += 1) {
      const started = nowMs();
      const response = await fetch(`${baseUrl}${path}`, { headers: { cookie }, redirect: "manual" });
      const body = await response.arrayBuffer();
      samples.push(nowMs() - started);
      bytes = body.byteLength;
    }
    results.push({
      path,
      status,
      medianMs: Math.round(await median(samples)),
      minMs: Math.round(Math.min(...samples)),
      maxMs: Math.round(Math.max(...samples)),
      bytes,
    });
  }
  return results;
}

async function measureQueries(prisma, ledger, sampleCount) {
  const accountIds = [ledger.userAccountId].filter(Boolean);
  const targets = [
    {
      name: "ledger-statement-window",
      run: () =>
        prisma.ledgerEntry.findMany({
          where: { accountId: { in: accountIds } },
          orderBy: [{ transaction: { occurredAt: "asc" } }, { sequence: "asc" }],
        }),
      planSql: `SELECT e.* FROM "LedgerEntry" e JOIN "LedgerTransaction" t ON t.id = e.transactionId WHERE e.accountId IN ('${accountIds[0] ?? "none"}') ORDER BY t.occurredAt ASC, e.sequence ASC`,
    },
    {
      name: "ledger-balance-aggregate",
      run: () =>
        prisma.$queryRawUnsafe(
          `SELECT e."accountId" AS "accountId", e."direction" AS "direction", SUM(CAST(e."amountMinor" AS DECIMAL)) AS "total", COUNT(*) AS "entries" ` +
            `FROM "LedgerEntry" e WHERE e."accountId" IN ('${accountIds[0] ?? "none"}') GROUP BY e."accountId", e."direction"`,
        ),
      planSql: `SELECT e."accountId", e."direction", SUM(CAST(e."amountMinor" AS DECIMAL)), COUNT(*) FROM "LedgerEntry" e WHERE e."accountId" IN ('${accountIds[0] ?? "none"}') GROUP BY e."accountId", e."direction"`,
    },
    {
      name: "ledger-statement-page",
      run: () =>
        prisma.ledgerEntry.findMany({
          where: {
            accountId: { in: accountIds },
            transaction: { occurredAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } },
          },
          orderBy: [{ transaction: { occurredAt: "desc" } }, { sequence: "desc" }, { id: "desc" }],
          take: 500,
        }),
      planSql: `SELECT e.* FROM "LedgerEntry" e JOIN "LedgerTransaction" t ON t.id = e.transactionId WHERE e.accountId IN ('${accountIds[0] ?? "none"}') AND t.occurredAt >= '2026-01-01' ORDER BY t.occurredAt DESC, e.sequence DESC, e.id DESC LIMIT 500`,
    },
    {
      name: "ledger-range-in-window",
      run: () =>
        prisma.ledgerEntry.findMany({
          where: { accountId: { in: accountIds }, transaction: { occurredAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } } },
          orderBy: [{ transaction: { occurredAt: "asc" } }, { sequence: "asc" }],
        }),
      planSql: `SELECT e.* FROM "LedgerEntry" e JOIN "LedgerTransaction" t ON t.id = e.transactionId WHERE e.accountId IN ('${accountIds[0] ?? "none"}') AND t.occurredAt >= '2026-01-01' ORDER BY t.occurredAt ASC, e.sequence ASC`,
    },
    {
      name: "audit-newest-page",
      run: () =>
        prisma.auditEvent.findMany({
          where: { action: { contains: "ORDER" }, occurredAt: { gte: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) } },
          orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
          take: 200,
        }),
      planSql: `SELECT * FROM "AuditEvent" WHERE action LIKE '%ORDER%' AND occurredAt >= '2026-01-01' ORDER BY occurredAt DESC, id DESC LIMIT 200`,
    },
    {
      name: "audit-source-page",
      run: () =>
        prisma.auditEvent.findMany({
          where: { source: "runner" },
          orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
          take: 200,
        }),
      planSql: `SELECT * FROM "AuditEvent" WHERE source = 'runner' ORDER BY occurredAt DESC, id DESC LIMIT 200`,
    },
    {
      name: "orders-open-for-market",
      run: () =>
        prisma.tradeOrder.findMany({
          where: { userId: "dev-owner-user", market: "BTC-USD", status: { notIn: ["FILLED", "CANCELLED", "FAILED", "REJECTED"] } },
          orderBy: { createdAt: "desc" },
          take: 50,
        }),
      planSql: `SELECT * FROM "TradeOrder" WHERE userId = 'dev-owner-user' AND market = 'BTC-USD' AND status NOT IN ('FILLED','CANCELLED','FAILED','REJECTED') ORDER BY createdAt DESC LIMIT 50`,
    },
    {
      name: "orders-list-for-account",
      run: () =>
        prisma.tradeOrder.findMany({ where: { userId: "dev-owner-user" }, orderBy: { createdAt: "desc" }, take: 100 }),
      planSql: `SELECT * FROM "TradeOrder" WHERE userId = 'dev-owner-user' ORDER BY createdAt DESC LIMIT 100`,
    },
    {
      name: "decisions-for-account",
      run: () =>
        prisma.strategyDecision.findMany({
          where: { userId: "bench-strategy-user-0" },
          orderBy: { evaluatedAt: "desc" },
          take: 100,
        }),
      planSql: `SELECT * FROM "StrategyDecision" WHERE userId = 'bench-strategy-user-0' ORDER BY evaluatedAt DESC LIMIT 100`,
    },
  ];

  const results = [];
  for (const target of targets) {
    const samples = [];
    let rows = 0;
    for (let index = 0; index < sampleCount; index += 1) {
      const timed = await timeIt(target.run);
      samples.push(timed.ms);
      rows = Array.isArray(timed.value) ? timed.value.length : 0;
    }
    const plan = await prisma.$queryRawUnsafe(`EXPLAIN QUERY PLAN ${target.planSql}`).catch((error) => [
      { detail: error instanceof Error ? error.message : String(error) },
    ]);
    results.push({
      name: target.name,
      rows,
      medianMs: Math.round(await median(samples)),
      minMs: Math.round(Math.min(...samples)),
      maxMs: Math.round(Math.max(...samples)),
      plan: plan.map((line) => line.detail ?? JSON.stringify(line)),
    });
  }
  return results;
}

async function measureRunner(baseUrl) {
  let summary = null;
  const started = nowMs();
  const response = await fetch(`${baseUrl}/api/cron/strategy-activation`, {
    headers: { authorization: `Bearer ${PRODUCTION_ENV.CRON_SECRET}` },
  });
  summary = await response.json().catch(() => null);
  const status = response.status;
  const intervalSeconds = 5 * 60;
  const passMs = nowMs() - started;
  return {
    status,
    passMs,
    intervalSeconds,
    headroomSeconds: Math.round(intervalSeconds - passMs / 1000),
    summary,
  };
}

function toMarkdown(run) {
  const lines = [];
  lines.push(`## Run "${run.label}" — ${run.generatedAt}`);
  lines.push("");
  lines.push(`Volume: ${run.volume.ledgerEntries} ledger entries, ${run.volume.auditEvents} audit events, ${run.volume.orders} orders, ${run.volume.decisions} decisions, ${run.volume.runningStrategies} running strategies.`);
  lines.push("");
  lines.push("| Surface | Status | Median | Min | Max | Bytes |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const page of run.pages) {
    lines.push(`| \`${page.path}\` | ${page.status} | ${page.medianMs} ms | ${page.minMs} ms | ${page.maxMs} ms | ${page.bytes} |`);
  }
  lines.push("");
  lines.push("| Query | Rows | Median | Min | Max |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const query of run.queries) {
    lines.push(`| \`${query.name}\` | ${query.rows} | ${query.medianMs} ms | ${query.minMs} ms | ${query.maxMs} ms |`);
  }
  lines.push("");
  if (run.serverRssKb?.before && run.serverRssKb?.after) {
    lines.push(
      `Server RSS across the measured requests (including both full-range exports): ${run.serverRssKb.before} kB → ${run.serverRssKb.after} kB.`,
    );
  }
  if (run.heapMb) lines.push(`Server heap cap: --max-old-space-size=${run.heapMb} MB.`);
  lines.push(`Runner pass: ${run.runner.passMs} ms against ${run.runner.intervalSeconds} s interval (headroom ${run.runner.headroomSeconds} s), status ${run.runner.status}.`);
  if (run.runner.summary?.jobsRan !== undefined) {
    lines.push(`Runner jobs: ${run.runner.summary.jobsRan} ran, ${run.runner.summary.jobsFailed} failed, ${run.runner.summary.jobsSkipped} skipped.`);
  }
  return lines.join("\n");
}

async function compareRuns(labels) {
  const read = (label) => {
    const path = join(OUTPUT_DIR, `phase38-${label}.json`);
    if (!existsSync(path)) fail(`no stored run named "${label}" at ${path}.`);
    return JSON.parse(readFileSync(path, "utf8"));
  };
  const [before, after] = labels.map(read);
  const index = (run) => new Map(run.pages.map((page) => [page.path, page]));
  const beforePaths = index(before);
  const rows = after.pages.map((page) => {
    const prior = beforePaths.get(page.path);
    const change = prior ? Math.round(((page.medianMs - prior.medianMs) / Math.max(prior.medianMs, 1)) * 100) : null;
    return `| \`${page.path}\` | ${prior?.medianMs ?? "—"} ms | ${page.medianMs} ms | ${change === null ? "—" : `${change > 0 ? "+" : ""}${change}%`} |`;
  });
  console.log(`\n## ${before.label} → ${after.label}\n`);
  console.log("| Surface | Before | After | Change |");
  console.log("| --- | --- | --- | --- |");
  console.log(rows.join("\n"));
  const queryIndex = new Map(before.queries.map((query) => [query.name, query]));
  console.log("\n| Query | Before | After | Change |");
  console.log("| --- | --- | --- | --- |");
  for (const query of after.queries) {
    const prior = queryIndex.get(query.name);
    const change = prior ? Math.round(((query.medianMs - prior.medianMs) / Math.max(prior.medianMs, 1)) * 100) : null;
    console.log(`| \`${query.name}\` | ${prior?.medianMs ?? "—"} ms | ${query.medianMs} ms | ${change === null ? "—" : `${change > 0 ? "+" : ""}${change}%`} |`);
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.compare) {
    await compareRuns(options.compare);
    return;
  }

  ensureRuntime();
  resetBenchDatabase();
  pushSchema();

  const prisma = await openClient();
  let server = null;
  let proxy = null;
  try {
    const volume = options.volume === "empty" ? { ledgerEntries: 0, auditEvents: 0, orders: 0, decisions: 0, strategies: 0, candlesPerMarket: 0 } : STANDARD_VOLUME;
    const ledger = options.volume === "empty" ? await seedEmpty(prisma) : await seedVolume(prisma, volume);
    if (options.indexes === "without") await dropPhaseIndexes(prisma);
    const measuredVolume = await countVolume(prisma);
    const sessionCookie = await mintSession(prisma, PRODUCTION_ENV.SESSION_SECRET);

    // The client below is this bench's own; the server gets the same file through
    // DATABASE_URL and never shares the connection.
    log("bench: starting the production build…");
    server = spawn(join(APP_DIR, "node_modules", ".bin", "next"), ["start", "-p", PRODUCTION_ENV.BENCH_PORT], {
      cwd: APP_DIR,
      env: { ...process.env, ...serverOptions() },
      stdio: ["ignore", "pipe", "pipe"],
    });
    server.stdout.on("data", (chunk) => process.stderr.write(`[next] ${chunk}`));
    server.stderr.on("data", (chunk) => process.stderr.write(`[next] ${chunk}`));
    proxy = await startTlsProxy();
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    await waitForApp();

    const baseUrl = `https://localhost:${PRODUCTION_ENV.BENCH_TLS_PORT}`;
    const cookie = await sessionCookie;
    const rssBeforeKb = readServerRssKb(server.pid);
    log("bench: measuring HTTP surfaces…");
    const pages = await measureHttp(baseUrl, cookie, options.samples, [
      "/",
      "/trade",
      "/account",
      "/admin",
      "/api/ledger",
      "/api/trading/orders",
      "/api/admin/audit",
      // The exports are measured separately because their requirement is not just
      // latency: a year of ledger lines and the whole audit range must be written
      // without the server holding the range in memory.
      "/api/ledger?format=csv&from=2025-10-21&to=2026-10-20",
      "/api/admin/audit/export?format=csv",
    ]);
    log("bench: measuring queries and capturing plans…");
    const rssAfterKb = readServerRssKb(server.pid);
    const queries = await measureQueries(prisma, ledger, options.samples);
    log("bench: measuring one runner pass…");
    const runner = await measureRunner(baseUrl);

    const run = {
      label: options.label,
      generatedAt: new Date().toISOString(),
      indexes: options.indexes,
      heapMb: Number(process.env.BENCH_HEAP_MB ?? 512),
      node: process.version,
      database: "SQLite (prisma/bench.db, copied from prisma/dev.db)",
      volume: measuredVolume,
      serverRssKb: { before: rssBeforeKb, after: rssAfterKb },
      pages,
      queries,
      runner,
    };
    const path = join(OUTPUT_DIR, `phase38-${options.label}.json`);
    writeFileSync(path, `${JSON.stringify(run, null, 2)}\n`, "utf8");
    console.log(`\n${toMarkdown(run)}\n`);
    console.log(`Stored ${path}`);

    const missing = pages.filter((page) => page.status >= 400);
    if (missing.length > 0) {
      console.error(`bench: these surfaces answered with an error status: ${missing.map((page) => `${page.path} (${page.status})`).join(", ")}`);
      process.exitCode = 1;
    }
  } finally {
    if (!options.keep) {
      proxy?.close();
      server?.kill("SIGTERM");
    }
    await prisma.$disconnect();
    if (options.keep) log("bench: --keep given; the server and prisma/bench.db are still in place.");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
