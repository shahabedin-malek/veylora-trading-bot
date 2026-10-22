import assert from "node:assert/strict";
import test from "node:test";
import {
  createLogger,
  isSecretField,
  jsonLogSink,
  redactFields,
  redactString,
  redactUrl,
  serializeError,
  type LogRecord,
} from "@/lib/observability/logger";

const ALCHEMY_KEY = "Zx9QwErTyUiOpAsDfGhJkLzXcVbNm123";
const ALCHEMY_ENDPOINT = `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`;
const ENCRYPTION_KEY = "3f1a9c4e7b2d5f8a1c3e5b7d9f2a4c6e8b0d2f4a6c8e0b2d4f6a8c0e2b4d6f8a";
const BEARER_TOKEN = "sk-live-abcdefghijklmnopqrstuvwx";
const OWNER_ADDRESS = "0x1111111111111111111111111111111111111111";

test("a key-bearing URL is redacted in its path", () => {
  const redacted = redactUrl(ALCHEMY_ENDPOINT);
  assert.ok(!redacted.includes(ALCHEMY_KEY), `the key survived: ${redacted}`);
  assert.match(redacted, /alchemy\.com\/v2\/\[redacted\]/);
  // The marker replaces the secret itself, not the whole URL and not the
  // offset of the match (a capture-group mistake that reads as "6[redacted]").
  assert.equal(redactString(`token=${ALCHEMY_KEY}`), "token=[redacted]");
});

test("credentials in a query string, an authority and a bearer header value are redacted", () => {
  assert.ok(!redactUrl("https://api.example.com/x?api_key=topsecret123").includes("topsecret123"));
  assert.equal(redactUrl("https://user:passphrase@api.example.com/x"), "https://api.example.com/x");
  assert.ok(!redactString(`Authorization: Bearer ${BEARER_TOKEN}`).includes(BEARER_TOKEN));
});

test("a field whose name says secret never carries a value, at any depth", () => {
  const redacted = redactFields({
    apiKey: "plain-value-with-no-shape",
    ALCHEMY_API_KEY: "another",
    nested: { credential: "third", sessionSecret: "fourth" },
    safe: "kept",
  });
  assert.equal(redacted.apiKey, "[redacted]");
  assert.equal(redacted.ALCHEMY_API_KEY, "[redacted]");
  assert.deepEqual(redacted.nested, { credential: "[redacted]", sessionSecret: "[redacted]" });
  assert.equal(redacted.safe, "kept");
  assert.equal(isSecretField("cacheKey"), false);
  assert.equal(isSecretField("apiKey"), true);
});

test("an EVM address survives redaction, and a private-key shape does not", () => {
  // The owner's own data must stay legible in development.
  assert.equal(redactString(OWNER_ADDRESS), OWNER_ADDRESS);
  assert.equal(redactFields({ wallet: OWNER_ADDRESS }).wallet, OWNER_ADDRESS);
  assert.equal(redactString(`0x${ENCRYPTION_KEY}`), "[redacted]");
  assert.equal(redactString(ENCRYPTION_KEY), "[redacted]");
});

test("no key-like value survives into a log line", () => {
  const lines: string[] = [];
  const logger = createLogger({
    level: "error",
    requestId: "request-abc123",
    route: "/api/portfolio/ethereum",
    sink: jsonLogSink((line) => lines.push(line)),
  });

  logger.error("provider call failed", {
    url: ALCHEMY_ENDPOINT,
    encryptionKey: ENCRYPTION_KEY,
    headers: { Authorization: `Bearer ${BEARER_TOKEN}` },
    endpoint: `https://api.example.com?token=${BEARER_TOKEN}`,
  });
  logger.debug("plain line");

  assert.equal(lines.length, 1, "the debug line should be filtered at error level");
  const line = lines[0]!;
  for (const secret of [ALCHEMY_KEY, ENCRYPTION_KEY, BEARER_TOKEN]) {
    assert.ok(!line.includes(secret), `a secret reached the log line: ${line}`);
  }
  assert.ok(line.includes("[redacted]"));
  const record = JSON.parse(line) as LogRecord;
  assert.equal(record.level, "error");
  assert.equal(record.requestId, "request-abc123");
  assert.equal(record.route, "/api/portfolio/ethereum");
  assert.match(record.timestamp as string, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(record.message, "provider call failed");
});

test("the log level decides what is emitted, and the record is returned either way", () => {
  const lines: string[] = [];
  const logger = createLogger({ level: "warn", sink: jsonLogSink((line) => lines.push(line)) });
  const record = logger.debug("filtered out");
  assert.equal(record.level, "debug");
  assert.equal(lines.length, 0);
  logger.warn("kept");
  assert.equal(lines.length, 1);
});

test("development keeps the stack and the provider body; production keeps neither", () => {
  const error = Object.assign(new Error(`lookup failed for ${ALCHEMY_ENDPOINT}`), { code: "ENOTFOUND", details: `body: ${BEARER_TOKEN}` });

  const development = serializeError(error, { NODE_ENV: "development" });
  assert.equal(development.code, "ENOTFOUND");
  assert.ok(development.stack?.includes("Error"), "development should carry the stack");
  assert.ok(!JSON.stringify(development.details).includes(BEARER_TOKEN), "the provider body is redacted too");
  assert.ok(!development.message.includes(ALCHEMY_KEY), "the key in the message is redacted");

  const production = serializeError(error, { NODE_ENV: "production" });
  assert.equal(production.stack, undefined);
  assert.equal(production.details, undefined);
  assert.equal(production.code, "ENOTFOUND");
});

test("a non-error value is still described rather than dropped", () => {
  assert.deepEqual(serializeError("something went wrong"), { name: "Error", message: "something went wrong" });
  assert.match(serializeError({ odd: true }).message, /Non-error failure/);
});
