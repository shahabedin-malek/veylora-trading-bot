import assert from "node:assert/strict";
import test from "node:test";
import { doesAlertTrigger, validateNewMarketAlert } from "@/lib/alerts/conditions";

test("alert creation accepts only supported Coinbase USD price and RSI conditions", () => {
  assert.deepEqual(validateNewMarketAlert({ symbol: "BTC-USD", condition: "PRICE_ABOVE", threshold: "70000.25" }), {
    valid: true,
    value: { symbol: "BTC-USD", condition: "PRICE_ABOVE", threshold: "70000.25" },
  });
  assert.equal(validateNewMarketAlert({ symbol: "BTC-USD", condition: "RSI_14_BELOW", threshold: "30" }).valid, true);
  assert.equal(validateNewMarketAlert({ symbol: "UNKNOWN-USD", condition: "PRICE_ABOVE", threshold: "1" }).valid, false);
  assert.equal(validateNewMarketAlert({ symbol: "BTC-USD", condition: "PRICE_ABOVE", threshold: "0" }).valid, false);
  assert.equal(validateNewMarketAlert({ symbol: "BTC-USD", condition: "RSI_14_ABOVE", threshold: "101" }).valid, false);
  assert.equal(validateNewMarketAlert({ symbol: "BTC-USD", condition: "PRICE_ABOVE", threshold: "1e9" }).valid, false);
  assert.equal(validateNewMarketAlert({ symbol: "BTC-USD", condition: "PRICE_ABOVE", threshold: "1", venue: "binance" }).valid, false);
});

test("price and RSI conditions compare decimal thresholds inclusively", () => {
  assert.equal(doesAlertTrigger("PRICE_ABOVE", "100.10", "100.1"), true);
  assert.equal(doesAlertTrigger("PRICE_BELOW", "99.9", "99.8"), true);
  assert.equal(doesAlertTrigger("RSI_14_ABOVE", "70", "69.9999"), false);
  assert.equal(doesAlertTrigger("RSI_14_BELOW", "30", "30"), true);
});