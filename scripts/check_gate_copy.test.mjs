import assert from "node:assert/strict";
import test from "node:test";
import {
  GATE_PHRASES,
  findGateCopy,
  findGateCopyLines,
  isTestFile,
  scanAppCopy,
} from "./check_gate_copy.mjs";

test("every gate phrase is caught, so no entry is dead weight", () => {
  for (const phrase of GATE_PHRASES) {
    assert.deepEqual(findGateCopy(`<p>${phrase}</p>`), [phrase], `expected to catch "${phrase}"`);
  }
});

test("gate phrases are matched case-insensitively", () => {
  assert.deepEqual(findGateCopy("<p>Owner Approval is required.</p>"), ["owner approval"]);
});

test("wrapped copy across JSX lines is still caught with a line number", () => {
  const source = ['<p className="note">', "  Withdrawals remain", "  disabled under current policy.", "</p>"].join("\n");
  assert.deepEqual(findGateCopy(source), ["withdrawals remain disabled"]);
  assert.deepEqual(findGateCopyLines(source), [
    { line: 2, phrase: "withdrawals remain disabled", text: "Withdrawals remain" },
  ]);
});

test("ordinary vocabulary that merely contains a gate word is not caught", () => {
  assert.deepEqual(findGateCopy("const aggregated = delegate(x, y);"), []);
  assert.deepEqual(findGateCopy("Use keys with read-only permissions."), []);
  assert.deepEqual(findGateCopy("Symbols come from the approvedSymbols allow-list."), []);
});

test("functional identifiers stay legal", () => {
  const source = [
    "if (!input.venueApproved) reasons.add(\"venue-not-approved\");",
    "if (!sameOriginRequest(request)) return forbidden();",
    "if (!config.allowedChainIds.has(body.chainId)) return forbidden();",
  ].join("\n");
  assert.deepEqual(findGateCopy(source), []);
});

test("test files are skipped, since they may quote removed copy to assert its absence", () => {
  assert.equal(isTestFile("apps/web/src/lib/assistant/public-market-adapter.test.ts"), true);
  assert.equal(isTestFile("apps/web/src/app/api/auth/verify/route.spec.tsx"), true);
  assert.equal(isTestFile("apps/web/src/app/page.tsx"), false);
});

test("the app's user-facing copy is free of removed restriction copy", async () => {
  const failures = await scanAppCopy();
  assert.deepEqual(
    failures.map(({ file, line, phrase }) => `${file}${line ? `:${line}` : ""} "${phrase}"`),
    [],
    "removed gate copy reappeared in the app",
  );
});
