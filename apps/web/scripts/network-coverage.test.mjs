import assert from "node:assert/strict";
import test from "node:test";
import { buildCoverageReport, parseScopeSections, slugFromVariable } from "./network-coverage.mjs";

const MANIFEST = `# Manifest

## Development (3 names, 3 entries)
ALCHEMY_BASE_MAINNET_RPC_URL
ALCHEMY_ARB_MAINNET_RPC_URL
ALCHEMY_ETHEREUM_MAINNET_BEACON_RPC_URL

## Preview, Production (2 names, 2 entries)
ALCHEMY_BASE_MAINNET_RPC_URL
ALCHEMY_ARB_MAINNET_RPC_URL

## Production (1 names, 1 entries)
DATABASE_URL
`;

test("derives a slug from a network variable", () => {
  assert.equal(slugFromVariable("ALCHEMY_BASE_MAINNET_RPC_URL"), "base-mainnet");
  assert.equal(slugFromVariable("ALCHEMY_ETHEREUM_MAINNET_BEACON_RPC_URL"), "ethereum-mainnet-beacon");
  assert.equal(slugFromVariable("ALCHEMY_API_KEY"), null);
});

test("a merged heading declares its names in both scopes", () => {
  const sections = parseScopeSections(MANIFEST);
  assert.deepEqual(sections.map(({ scopes }) => scopes), [["Development"], ["Preview", "Production"], ["Production"]]);
  const merged = sections[1];
  assert.deepEqual(merged.names, ["ALCHEMY_BASE_MAINNET_RPC_URL", "ALCHEMY_ARB_MAINNET_RPC_URL"]);
});

test("the report shows each scope side by side and finds the gap", () => {
  const report = buildCoverageReport(MANIFEST.replace(
    "ALCHEMY_ARB_MAINNET_RPC_URL\n\n## Production",
    "\n## Production",
  ));
  // The edit above drops ARB only from the merged Preview/Production section.
  assert.deepEqual(report.counts, { Development: 2, Preview: 1, Production: 1 });
  assert.deepEqual(report.missing.Preview, ["arb-mainnet"]);
  assert.deepEqual(report.missing.Production, ["arb-mainnet"]);
  assert.deepEqual(report.missing.Development, []);
  assert.equal(report.totalNetworks, 2);
});

test("beacon endpoints are ignored, not counted as networks", () => {
  const report = buildCoverageReport(MANIFEST);
  assert.equal(report.totalNetworks, 2);
  assert.deepEqual(report.networks.Development, ["arb-mainnet", "base-mainnet"]);
  assert.deepEqual(report.ignoredBeaconVariables, ["ALCHEMY_ETHEREUM_MAINNET_BEACON_RPC_URL"]);
  assert.deepEqual(report.missing.Preview, []);
});

test("a manifest with no network section is an error, not an empty pass", () => {
  assert.throws(
    () => buildCoverageReport("## Development (1 names, 1 entries)\nDATABASE_URL\n"),
    /No network section was found/,
  );
});
