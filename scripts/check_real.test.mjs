import assert from "node:assert/strict";
import test from "node:test";
import { findBannedTerms, validateProductionUrl } from "./check_real.mjs";

test("realness scan rejects fabricated-data markers", () => {
  assert.deepEqual(findBannedTerms('const price = "mock";'), ["mock"]);
  assert.deepEqual(findBannedTerms('const price = "fake";'), ["fake"]);
  assert.deepEqual(findBannedTerms('const price = "dummy";'), ["dummy"]);
});

test("realness scan permits an honest unavailable state", () => {
  assert.deepEqual(findBannedTerms('const status = "Not connected";'), []);
});

test("realness scan permits honest UI and sandbox labels", () => {
  assert.deepEqual(findBannedTerms('<input placeholder="0.0" />'), []);
  assert.deepEqual(findBannedTerms('const engine = "paper-trading";'), []);
  assert.deepEqual(findBannedTerms("Simulated fills only; no live orders."), []);
});

test("endpoint validation rejects non-production networks", () => {
  assert.equal(
    validateProductionUrl("https://api.testnet.example/v1"),
    "endpoint targets a non-production network",
  );
  assert.equal(
    validateProductionUrl("wss://ws-feed-public.sandbox.exchange.coinbase.com"),
    "endpoint targets a non-production network",
  );
});

test("endpoint validation accepts HTTPS/WSS endpoints and rejects other schemes", () => {
  assert.equal(validateProductionUrl("https://api.example.com/v1"), null);
  assert.equal(validateProductionUrl("wss://ws.example.com/socket"), null);
  assert.equal(validateProductionUrl("http://api.example.com/v1"), "endpoint must use HTTPS or secure WebSocket");
  assert.equal(validateProductionUrl("not-a-url"), "invalid endpoint URL");
});
