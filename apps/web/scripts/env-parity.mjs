#!/usr/bin/env node
/**
 * Environment parity across the three deployment scopes.
 *
 * `network-coverage.mjs` answers "does every scope have the same RPC networks?". This answers the
 * wider question phase 40 asks: "does every variable Production holds also exist in Preview and
 * Development, and where it does not, which variable is it?"
 *
 * It reads the names-only manifest (`plan/ENVIRONMENT_MANIFEST.txt`), whose sections name the
 * scopes each block applies to. Names only: the manifest never records a value and this report
 * prints none.
 *
 * A difference that is intended is declared in `KNOWN_DIFFERENCES` with the reason, so the check
 * stays honest instead of accumulating silence. Anything else that Production has and another
 * scope lacks fails `--check`.
 *
 *   node scripts/env-parity.mjs            # report, exit 0
 *   node scripts/env-parity.mjs --check    # exit 1 on an undeclared gap between scopes
 *   node scripts/env-parity.mjs --strict   # also exit 1 on a required name the manifest does not record
 *   node scripts/env-parity.mjs --json     # machine-readable
 *
 * `--check` is the CI gate: it compares the three scopes and fails when Production holds something
 * another scope lacks without a reason. `--strict` is the pre-publish gate the runbook calls: it
 * additionally refuses to pass while a name the code cannot work without is unrecorded, which is
 * the one failure a scope-to-scope comparison cannot see.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const DEFAULT_MANIFEST_PATH = resolve(REPO_ROOT, "plan/ENVIRONMENT_MANIFEST.txt");
export const SCOPES = ["Development", "Preview", "Production"];

const SECTION_HEADER = /^##\s+([A-Za-z, ]+?)\s*\((\d+)\s+names?,\s*(\d+)\s+entries?\)\s*$/;
const NAME_LINE = /^([A-Z][A-Z0-9_]*)\s*$/;

/**
 * Differences between the scopes that are intended, with the reason the phase report gives.
 * A key is `<variable>|<scope>`: the scope that does not have it.
 */
export const KNOWN_DIFFERENCES = Object.freeze({
  // Development runs against a local SQLite file it creates itself, so it needs no Neon
  // connection string; a development run that pointed at the production database would be the
  // failure this difference prevents.
  "DATABASE_URL|Development": "development uses the local SQLite file created by `db:setup`",
  "DATABASE_URL_UNPOOLED|Development": "development has no pooled/direct pair to reconcile",
  "DB_PROVIDER|Development": "the provider is implied by the local file",
  // A preview deployment is served on its own origin; sign-in reads the configured origin.
  "APP_BASE_URL|Development": "development reads APP_BASE_URL from `.env` for localhost",

  // Development's secrets are not in the host at all: `apps/web/.env` holds them, and
  // `.env.example` documents each one. The manifest is a read of the three hosted scopes, so a
  // Development gap here means "local file", not "missing everywhere".
  "SESSION_SECRET|Development": "development reads it from `apps/web/.env`; `.env.example` documents it",
  "CRON_SECRET|Development": "development reads it from `.env` and calls the cron route by hand; no host schedule delivers it",

  // Production holds this name, but this build never reads it — the credential vault reads
  // TRADING_CREDENTIAL_ENCRYPTION_KEY (see `REQUIRED_NAMES` below, which reports that name as
  // unconfirmed in every scope). Declared rather than added so the stale name is visible.
  "CREDENTIAL_ENCRYPTION_KEY|Preview": "stale name: this build reads TRADING_CREDENTIAL_ENCRYPTION_KEY, never this",
  "CREDENTIAL_ENCRYPTION_KEY|Development": "stale name: this build reads TRADING_CREDENTIAL_ENCRYPTION_KEY, never this",

  // A preview deployment must not drive the scheduled runner against the shared database: two
  // runners would claim the same jobs and trade twice. Preview therefore has no cron secret.
  "CRON_SECRET|Preview": "preview must not run the scheduled runner against the shared database",

  // Configured in Production but not read by anything in this build. Their absence cannot change
  // behaviour in another scope; the honest fix is to delete them from Production (or wire them),
  // which is the owner's call, so they are recorded instead of being silently ignored.
  "COMPLIANCE_PROVIDER|Preview": "Production holds it; no code in this build reads it",
  "COMPLIANCE_PROVIDER|Development": "Production holds it; no code in this build reads it",
  "CUSTODY_PROVIDER|Preview": "Production holds it; no code in this build reads it — venue funds stay at the venue",
  "CUSTODY_PROVIDER|Development": "Production holds it; no code in this build reads it — venue funds stay at the venue",
  "CUSTODY_KEY_ID|Preview": "Production holds it; no code in this build reads it",
  "CUSTODY_KEY_ID|Development": "Production holds it; no code in this build reads it",
  "OWNER_WALLET_ADDRESSES|Preview": "Production holds it; the OWNER role comes from the access directory, not this name",
  "OWNER_WALLET_ADDRESSES|Development": "Production holds it; the OWNER role comes from the access directory, not this name",
  "WALLET_RPC_URL_ARBITRUM|Preview": "Production holds it; the browser reads NEXT_PUBLIC_WALLET_RPC_URL_ARBITRUM, which all three scopes have",
  "WALLET_RPC_URL_ARBITRUM|Development": "Production holds it; the browser reads NEXT_PUBLIC_WALLET_RPC_URL_ARBITRUM, which all three scopes have",
  "WALLET_RPC_URL_BASE|Preview": "Production holds it; the browser reads NEXT_PUBLIC_WALLET_RPC_URL_BASE, which all three scopes have",
  "WALLET_RPC_URL_BASE|Development": "Production holds it; the browser reads NEXT_PUBLIC_WALLET_RPC_URL_BASE, which all three scopes have",
  "WALLET_RPC_URL_ETHEREUM|Preview": "Production holds it; the browser reads NEXT_PUBLIC_WALLET_RPC_URL_ETHEREUM, which all three scopes have",
  "WALLET_RPC_URL_ETHEREUM|Development": "Production holds it; the browser reads NEXT_PUBLIC_WALLET_RPC_URL_ETHEREUM, which all three scopes have",
});

/**
 * Names this build reads and cannot work without, in the scope that serves users.
 *
 * Parity answers "does Production have what Preview has?". This answers the other half: "does
 * Production have what the *code* needs?" — which the manifest alone cannot tell you, because a
 * variable can be missing from every scope and still show up as perfectly even.
 *
 * A name listed here that the manifest does not record in a scope is reported as *unconfirmed*
 * rather than as a gap: the manifest is a names-only read of the host, so `--check` refusing to
 * pass is the signal to look at the project settings before publishing, not proof of an outage.
 */
export const REQUIRED_NAMES = Object.freeze({
  DATABASE_URL: { scopes: ["Preview", "Production"], purpose: "the ledger, accounts and runner heartbeats" },
  SESSION_SECRET: { scopes: ["Preview", "Production"], purpose: "sign-in is closed without it" },
  APP_BASE_URL: { scopes: ["Preview", "Production"], purpose: "SIWE messages are bound to this origin" },
  AUTH_EVM_CHAIN_IDS: { scopes: ["Preview", "Production"], purpose: "no chain is approved for sign-in without it" },
  TRADING_CREDENTIAL_ENCRYPTION_KEY: {
    scopes: ["Preview", "Production"],
    purpose: "venue keys, TOTP secrets and webhook secrets are encrypted with it",
  },
  INITIAL_ADMIN_EVM_ADDRESS: { scopes: ["Preview", "Production"], purpose: "the first sign-in that becomes OWNER" },
  CRON_SECRET: { scopes: ["Production"], purpose: "the scheduled runner cannot be called without it" },
  DEPOSIT_ADDRESS_MNEMONIC: { scopes: ["Production"], purpose: "every deposit address is derived from it" },
  WITHDRAWAL_HOT_WALLET_MNEMONIC: { scopes: ["Production"], purpose: "nothing can be signed for a withdrawal without it" },
});

export function unconfirmedRequired(perScope) {
  const unconfirmed = [];
  for (const [name, { scopes, purpose }] of Object.entries(REQUIRED_NAMES)) {
    for (const scope of scopes) {
      if (perScope[scope]?.has(name)) continue;
      unconfirmed.push({ name, scope, purpose });
    }
  }
  return unconfirmed;
}

/** Every variable name per scope, read from the sections that name it. */
export function parseManifest(text) {
  const perScope = Object.fromEntries(SCOPES.map((scope) => [scope, new Set()]));
  const declared = { names: 0, entries: 0 };
  let current = null;

  for (const raw of text.split("\n")) {
    const header = SECTION_HEADER.exec(raw.trim());
    if (header) {
      const scopes = header[1].split(",").map((scope) => scope.trim()).filter((scope) => SCOPES.includes(scope));
      current = scopes.length > 0 ? scopes : null;
      if (current) {
        declared.names += Number(header[2]);
        declared.entries += Number(header[3]);
      }
      continue;
    }
    if (raw.startsWith("## ")) {
      current = null;
      continue;
    }
    if (!current) continue;
    const name = NAME_LINE.exec(raw.trim());
    if (!name) continue;
    for (const scope of current) perScope[scope].add(name[1]);
  }

  return { perScope, declared };
}

export function compareScopes(perScope) {
  const production = [...perScope.Production].sort();
  const gaps = [];
  for (const name of production) {
    for (const scope of ["Preview", "Development"]) {
      if (perScope[scope].has(name)) continue;
      const key = `${name}|${scope}`;
      gaps.push({ name, scope, declared: KNOWN_DIFFERENCES[key] ?? null });
    }
  }
  const developmentOnly = [...perScope.Development].filter((name) => !perScope.Production.has(name)).sort();
  const previewOnly = [...perScope.Preview].filter((name) => !perScope.Production.has(name)).sort();
  return {
    gaps,
    unconfirmed: unconfirmedRequired(perScope),
    developmentOnly,
    previewOnly,
    counts: Object.fromEntries(SCOPES.map((scope) => [scope, perScope[scope].size])),
  };
}

function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const check = args.includes("--check") || args.includes("--strict");
  const strict = args.includes("--strict");
  const text = readFileSync(DEFAULT_MANIFEST_PATH, "utf8");
  const { perScope, declared } = parseManifest(text);
  const result = compareScopes(perScope);
  const undeclared = result.gaps.filter((gap) => !gap.declared);

  if (asJson) {
    console.log(JSON.stringify({ manifest: DEFAULT_MANIFEST_PATH, declared, ...result, undeclared }, null, 2));
  } else {
    console.log(`Environment parity from ${DEFAULT_MANIFEST_PATH} (names only)`);
    console.log(`Declared by the manifest: ${declared.names} names, ${declared.entries} scope entries\n`);
    console.log("SCOPE        VARIABLES");
    for (const scope of SCOPES) console.log(`${scope.padEnd(12)} ${String(result.counts[scope]).padStart(9)}`);
    console.log("");
    console.log(`Production variables missing elsewhere: ${result.gaps.length} (${result.gaps.filter((gap) => gap.declared).length} declared)`);
    for (const gap of result.gaps) {
      console.log(`  ${gap.scope.padEnd(12)} ${gap.name}${gap.declared ? ` — declared: ${gap.declared}` : " — UNDECLARED"}`);
    }
    console.log("");
    console.log(`Development-only: ${result.developmentOnly.length}${result.developmentOnly.length ? ` (${result.developmentOnly.join(", ")})` : ""}`);
    console.log(`Preview-only:     ${result.previewOnly.length}${result.previewOnly.length ? ` (${result.previewOnly.join(", ")})` : ""}`);
    console.log("");
    console.log(`Required by the code and unconfirmed by the manifest: ${result.unconfirmed.length}`);
    for (const missing of result.unconfirmed) {
      console.log(`  ${missing.scope.padEnd(12)} ${missing.name} — ${missing.purpose}`);
    }
    console.log("");
    console.log(
      undeclared.length === 0
        ? "Parity: OK — every Production variable is present in the other scopes, or its absence is declared."
        : `Parity: FAIL — ${undeclared.length} undeclared gap(s). Declare each in KNOWN_DIFFERENCES or add the variable to the scope.`,
    );
    console.log(
      result.unconfirmed.length === 0
        ? "Required names: all recorded by the manifest."
        : `Required names: ${result.unconfirmed.length} unconfirmed by the manifest — resolve them in the host's project settings. \`--strict\` fails on these; \`--check\` does not.`,
    );
  }

  if (strict && result.unconfirmed.length > 0) process.exitCode = 1;
  if (check && undeclared.length > 0) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main();
