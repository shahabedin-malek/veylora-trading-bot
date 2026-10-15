import assert from "node:assert/strict";
import test from "node:test";
import { GET, POST } from "./route";

function withEnvCleared(run: () => Promise<void>): Promise<void> {
  const previous = {
    apiKey: process.env.AI_GATEWAY_API_KEY,
    oidc: process.env.VERCEL_OIDC_TOKEN,
    model: process.env.AI_GATEWAY_MODEL,
  };
  delete process.env.AI_GATEWAY_API_KEY;
  delete process.env.VERCEL_OIDC_TOKEN;
  delete process.env.AI_GATEWAY_MODEL;
  return run().finally(() => {
    if (previous.apiKey === undefined) delete process.env.AI_GATEWAY_API_KEY;
    else process.env.AI_GATEWAY_API_KEY = previous.apiKey;
    if (previous.oidc === undefined) delete process.env.VERCEL_OIDC_TOKEN;
    else process.env.VERCEL_OIDC_TOKEN = previous.oidc;
    if (previous.model === undefined) delete process.env.AI_GATEWAY_MODEL;
    else process.env.AI_GATEWAY_MODEL = previous.model;
  });
}

test("assistant readiness reports adapter enabled and model access unconfigured without credentials", async () => {
  await withEnvCleared(async () => {
    const response = await GET();
    assert.deepEqual(await response.json(), {
      adapterEnabled: true,
      target: "Vercel AI Gateway",
      modelConfigured: false,
      model: null,
    });
  });
});

test("assistant route rejects malformed messages and stops before model requests when unconfigured", async () => {
  await withEnvCleared(async () => {
    const malformed = await POST(new Request("http://localhost/api/assistant", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: "not-an-array" }),
    }));
    assert.equal(malformed.status, 400);

    const overlong = await POST(new Request("http://localhost/api/assistant", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "x".repeat(2_001) }] }),
    }));
    assert.equal(overlong.status, 400);

    const unconfigured = await POST(new Request("http://localhost/api/assistant", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "What is BTC-USD?" }] }),
    }));
    assert.equal(unconfigured.status, 503);
    assert.equal((await unconfigured.json()).status, "unconfigured");
  });
});
