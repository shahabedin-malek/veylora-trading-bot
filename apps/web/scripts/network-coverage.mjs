#!/usr/bin/env node
/**
 * Network coverage across deployment scopes.
 *
 * The registry in the app can only see the environment of the process it runs
 * in, so it cannot tell you that a network exists in Development but is missing
 * from Preview. This report can: it reads the names-only environment manifest
 * (`plan/ENVIRONMENT_MANIFEST.txt`) and compares the configured
 * `ALCHEMY_<NETWORK>_RPC_URL` set per scope.
 *
 * Names only. The manifest never records a value, and neither does this report.
 *
 *   node scripts/network-coverage.mjs          # report, exit 0
 *   node scripts/network-coverage.mjs --check  # exit 1 if a scope is missing a network
 *   node scripts/network-coverage.mjs --json   # machine-readable
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const DEFAULT_MANIFEST_PATH = resolve(REPO_ROOT, "plan/ENVIRONMENT_MANIFEST.txt");
export const SCOPES = ["Development", "Preview", "Production"];

const SECTION_HEADER = /^##\s+(.+?)\s*(?:\((\d+)\s+names?,\s*(\d+)\s+entries?\))?\s*$/;
const NETWORK_VARIABLE = /^ALCHEMY_([A-Z0-9]+(?:_[A-Z0-9]+)*)_RPC_URL$/;
const BEACON_VARIABLE = /_BEACON_RPC_URL$/;

export function slugFromVariable(variable) {
  const match = NETWORK_VARIABLE.exec(variable.trim());
  return match ? match[1].toLowerCase().replace(/_/g, "-") : null;
}

/**
 * Parse the manifest into scope sections. A heading such as
 * "Preview, Production" declares the same names in both scopes.
 */
export function parseScopeSections(text) {
  const sections = [];
  let current = null;
  for (const line of text.split("\n")) {
    const header = SECTION_HEADER.exec(line);
    if (header) {
      const scopes = header[1].split(",").map((scope) => scope.trim()).filter(Boolean);
      current = { scopes, names: [], declaredNames: header[2] ? Number(header[2]) : null };
      sections.push(current);
      continue;
    }
    if (!current) continue;
    const name = line.trim();
    if (!name || name.startsWith("#")) continue;
    current.names.push(name);
  }
  return sections;
}

/**
 * Compare the network sets of every scope the manifest declares.
 *
 * `missing` is the union of all scopes minus the scope's own set: a network that
 * exists anywhere and not here is exactly the silent loss this report is for.
 */
export function buildCoverageReport(text) {
  const sections = parseScopeSections(text);
  const byScope = Object.fromEntries(SCOPES.map((scope) => [scope, new Set()]));
  const beaconVariables = new Set();
  const seenScopes = new Set();

  for (const section of sections) {
    for (const rawName of section.names) {
      if (BEACON_VARIABLE.test(rawName)) {
        beaconVariables.add(rawName);
        continue;
      }
      const slug = slugFromVariable(rawName);
      if (!slug) continue;
      for (const scope of section.scopes) {
        if (!byScope[scope]) continue;
        seenScopes.add(scope);
        byScope[scope].add(slug);
      }
    }
  }

  if (seenScopes.size === 0) {
    throw new Error("No network section was found in the environment manifest.");
  }

  const all = new Set(SCOPES.flatMap((scope) => [...byScope[scope]]));
  const networks = Object.fromEntries(SCOPES.map((scope) => [scope, [...byScope[scope]].sort()]));
  const missing = Object.fromEntries(
    SCOPES.map((scope) => [scope, [...all].filter((slug) => !byScope[scope].has(slug)).sort()]),
  );
  const declaredOnly = Object.fromEntries(
    SCOPES.map((scope) => [scope, byScope[scope].size]),
  );

  return {
    scopes: SCOPES.filter((scope) => seenScopes.has(scope)),
    networks,
    counts: declaredOnly,
    missing,
    totalNetworks: all.size,
    ignoredBeaconVariables: [...beaconVariables].sort(),
    scopesAbsentFromManifest: SCOPES.filter((scope) => !seenScopes.has(scope)),
  };
}

function printReport(report, manifestPath) {
  console.log(`Network coverage from ${manifestPath} (names only)`);
  console.log(`${report.totalNetworks} distinct network(s) across ${report.scopes.length} scope(s)\n`);
  const width = Math.max(...report.scopes.map((scope) => scope.length));
  console.log(`${"SCOPE".padEnd(width)}  NETWORKS`);
  for (const scope of report.scopes) {
    console.log(`${scope.padEnd(width)}  ${String(report.counts[scope]).padStart(8)}`);
  }
  console.log("");
  for (const scope of report.scopes) {
    const missing = report.missing[scope];
    console.log(`${scope} missing: ${missing.length === 0 ? "none" : missing.join(", ")}`);
  }
  if (report.scopesAbsentFromManifest.length > 0) {
    console.log(`\nNo section in the manifest for: ${report.scopesAbsentFromManifest.join(", ")}`);
  }
  if (report.ignoredBeaconVariables.length > 0) {
    console.log(`\nIgnored ${report.ignoredBeaconVariables.length} beacon endpoint(s): they are not JSON-RPC.`);
  }
}

function main(argv) {
  const manifestPath = argv.find((argument) => !argument.startsWith("--")) ?? DEFAULT_MANIFEST_PATH;
  let text;
  try {
    text = readFileSync(manifestPath, "utf8");
  } catch {
    console.error(`Could not read the environment manifest at ${manifestPath}.`);
    return 2;
  }
  let report;
  try {
    report = buildCoverageReport(text);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }

  if (argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report, manifestPath);
  }

  if (argv.includes("--check")) {
    const gaps = report.scopes.flatMap((scope) => report.missing[scope].map((slug) => `${scope}: ${slug}`));
    if (report.scopesAbsentFromManifest.length > 0 || gaps.length > 0) {
      if (!argv.includes("--json")) {
        console.error("\nA network configured in one scope is missing from another.");
      }
      return 1;
    }
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
