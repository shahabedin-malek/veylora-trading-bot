import assert from "node:assert/strict";
import test from "node:test";
import {
  describeReason,
  isReason,
  isReasonCode,
  parseReason,
  reason,
  reasonMessage,
  REASON_CODES,
  serializeReason,
  type ReasonCode,
} from "@/lib/observability/reason";

test("every reason code carries a specific sentence, never a bare fallback", () => {
  for (const code of REASON_CODES) {
    const built = reason(code);
    assert.equal(built.code, code);
    assert.ok(built.message.trim().length > 20, `${code} has a vague message: ${built.message}`);
    assert.notEqual(built.message.toLowerCase(), "something went wrong");
    assert.equal(typeof built.retryable, "boolean");
    assert.equal(built.message, reasonMessage(code));
  }
});

test("a caller can supply the specific sentence while the code still says what kind", () => {
  const built = reason("MISSING_CONFIGURATION", { variable: "AI_GATEWAY_MODEL", message: "AI_GATEWAY_MODEL is not set." });
  assert.equal(built.code, "MISSING_CONFIGURATION");
  assert.equal(built.message, "AI_GATEWAY_MODEL is not set.");
  assert.equal(built.variable, "AI_GATEWAY_MODEL");
  assert.equal(built.retryable, false);
});

test("serialisation is stable and omits empty optionals", () => {
  const built = reason("PROVIDER_RATE_LIMITED", { providerId: "coinbase-exchange" });
  assert.deepEqual(serializeReason(built), {
    code: "PROVIDER_RATE_LIMITED",
    message: reasonMessage("PROVIDER_RATE_LIMITED"),
    retryable: true,
    providerId: "coinbase-exchange",
  });
  assert.deepEqual(Object.keys(serializeReason(built)), ["code", "message", "retryable", "providerId"]);
});

test("a reason survives a JSON boundary unchanged", () => {
  const original = reason("STALE_DATA", { providerId: "coinbase-exchange", detail: "The newest quote was 4 minutes old." });
  const parsed = parseReason(JSON.parse(JSON.stringify(serializeReason(original))));
  assert.deepEqual(parsed, original);
});

test("an unusable payload parses to null rather than to an empty sentence", () => {
  assert.equal(parseReason(null), null);
  assert.equal(parseReason({ code: "NOT_A_REAL_CODE", message: "x", retryable: true }), null);
  assert.equal(parseReason({ code: "PROVIDER_ERROR", message: 12, retryable: true }), null);
  assert.equal(parseReason({ code: "PROVIDER_ERROR", message: "x" }), null);
  assert.equal(isReason({ code: "PROVIDER_ERROR", message: "x", retryable: false }), true);
});

test("a parsed reason keeps its code even when its message was blank", () => {
  const parsed = parseReason({ code: "INSUFFICIENT_BALANCE", message: "   ", retryable: false });
  assert.equal(parsed?.code, "INSUFFICIENT_BALANCE");
  assert.equal(parsed?.message, reasonMessage("INSUFFICIENT_BALANCE"));
});

test("the code guard accepts only codes this build knows", () => {
  assert.equal(isReasonCode("VENUE_UNAVAILABLE"), true);
  assert.equal(isReasonCode("MADE_UP"), false);
  assert.equal(isReasonCode(7), false);
});

test("a reason reads as one sentence carrying the variable and the provider", () => {
  const described = describeReason(
    reason("MISSING_CONFIGURATION", { variable: "ALCHEMY_API_KEY", providerId: "alchemy-rpc", detail: "No endpoint." }),
  );
  assert.match(described, /^MISSING_CONFIGURATION: /);
  assert.ok(described.includes("set ALCHEMY_API_KEY"));
  assert.ok(described.includes("provider alchemy-rpc"));
});

test("the retryable default matches what an action could change", () => {
  const retryable: ReasonCode[] = ["PROVIDER_ERROR", "PROVIDER_RATE_LIMITED", "VENUE_UNAVAILABLE", "DATABASE_UNAVAILABLE", "NO_ENTRY_CONDITION"];
  const final: ReasonCode[] = ["INSUFFICIENT_BALANCE", "INVALID_CREDENTIAL", "MISSING_CONFIGURATION", "ORDER_REJECTED"];
  for (const code of retryable) assert.equal(reason(code).retryable, true, code);
  for (const code of final) assert.equal(reason(code).retryable, false, code);
});
