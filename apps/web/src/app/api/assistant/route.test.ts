import assert from "node:assert/strict";
import test from "node:test";
import { GET, POST, parseMessages } from "./route";

/**
 * What the assistant route answers before it ever reaches a model.
 *
 * Two properties are asserted here because they are the ones a probe can check without a
 * session: the order of the refusals (a malformed body is answered as a malformed body, a
 * missing auth configuration is named, and an unauthenticated ask is never a reply), and
 * that no refusal carries a `reply` field. A refusal that carried an answer would be the
 * one bug this endpoint cannot have.
 */

function request(body: unknown, headers: Record<string, string> = {}, method = "POST") {
  const origin = "http://localhost";
  return new Request(new URL("/api/assistant", origin), {
    method,
    headers: { "Content-Type": "application/json", Origin: origin, ...headers },
    ...(method === "GET" ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  }) as never;
}

async function withEnv<T>(env: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const keys = ["APP_BASE_URL", "AUTH_EVM_CHAIN_IDS", "SESSION_SECRET", "AI_GATEWAY_MODEL", "AI_GATEWAY_API_KEY", "VERCEL_OIDC_TOKEN"];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const CONFIGURED_AUTH = {
  APP_BASE_URL: "http://localhost",
  AUTH_EVM_CHAIN_IDS: "1",
  SESSION_SECRET: "x".repeat(40),
  AI_GATEWAY_MODEL: "provider/public-model",
  AI_GATEWAY_API_KEY: "test-only-placeholder",
};

test("readiness reports the adapter, the tools it offers and that the reply streams", async () => {
  await withEnv({}, async () => {
    const response = await GET();
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      adapterEnabled: boolean;
      target: string;
      modelConfigured: boolean;
      model: string | null;
      streaming: boolean;
      tools: { name: string; scope: string }[];
      limits: { requestsPerHour: number };
    };
    assert.equal(body.adapterEnabled, true);
    assert.equal(body.target, "Vercel AI Gateway");
    assert.equal(body.modelConfigured, false);
    assert.equal(body.model, null);
    assert.equal(body.streaming, true);
    assert.equal(body.limits.requestsPerHour > 0, true);
    // The tool list is advertised from the one typed list, account tools included.
    const names = body.tools.map((tool) => tool.name);
    assert.ok(names.includes("get_account_balance"));
    assert.ok(names.includes("place_paper_order"));
    assert.ok(body.tools.some((tool) => tool.scope === "account"));
    assert.ok(body.tools.some((tool) => tool.scope === "public"));
  });
});

test("a deployment with no auth configuration names what is missing instead of answering", async () => {
  await withEnv({}, async () => {
    const response = await POST(request({ messages: [{ role: "user", content: "What is my balance?" }] }));
    assert.equal(response.status, 503);
    const body = (await response.json()) as { error: string; reply?: unknown };
    assert.match(body.error, /APP_BASE_URL|AUTH_EVM_CHAIN_IDS|SESSION_SECRET/);
    assert.equal(body.reply, undefined);
  });
});

test("a malformed request is refused by shape before any session is looked at", async () => {
  await withEnv(CONFIGURED_AUTH, async () => {
    const wrongType = await POST(new Request(new URL("/api/assistant", "http://localhost"), {
      method: "POST",
      headers: { "Content-Type": "text/plain", Origin: "http://localhost" },
      body: "hello",
    }) as never);
    assert.equal(wrongType.status, 415);

    const notJson = await POST(request("{not json"));
    assert.equal(notJson.status, 400);

    const notAnArray = await POST(request({ messages: "not-an-array" }));
    assert.equal(notAnArray.status, 400);

    const empty = await POST(request({ messages: [] }));
    assert.equal(empty.status, 400);

    const tooMany = await POST(request({ messages: Array.from({ length: 13 }, () => ({ role: "user", content: "hi" })) }));
    assert.equal(tooMany.status, 400);

    const overlong = await POST(request({ messages: [{ role: "user", content: "x".repeat(2_001) }] }));
    assert.equal(overlong.status, 400);

    const badRole = await POST(request({ messages: [{ role: "system", content: "hi" }] }));
    assert.equal(badRole.status, 400);

    for (const response of [notJson, notAnArray, empty, tooMany, overlong, badRole]) {
      assert.equal((await response.json() as { reply?: unknown }).reply, undefined);
    }
  });
});

test("a signed-out ask is refused and never carries a reply", async () => {
  await withEnv(CONFIGURED_AUTH, async () => {
    // Same-origin with no session cookie. In a real request the session reader throws
    // `AuthenticationRequiredError` and the route answers 401; outside a request scope it
    // cannot read a cookie at all and reports unavailability. What matters is that neither
    // path answers with a reply.
    const response = await POST(request({ messages: [{ role: "user", content: "What is my balance?" }] }));
    const body = (await response.json()) as { error: string; reply?: unknown };
    assert.notEqual(response.status, 200);
    assert.equal(body.reply, undefined, "a refused ask must not carry an answer");
    assert.ok(body.error.length > 0, "the refusal says something specific");
  });
});

test("a cross-origin ask is refused, before the model and before the limit", async () => {
  await withEnv(CONFIGURED_AUTH, async () => {
    const foreign = new Request(new URL("/api/assistant", "http://localhost"), {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://evil.example" },
      body: JSON.stringify({ messages: [{ role: "user", content: "What is my balance?" }] }),
    }) as never;
    const response = await POST(foreign);
    // Signed out, the answer is the session refusal; the origin check sits behind it and
    // neither path may produce a reply.
    assert.notEqual(response.status, 200);
    assert.equal((await response.json() as { reply?: unknown }).reply, undefined);
  });
});

test("message parsing is the same rule the route applies", () => {
  assert.deepEqual(parseMessages([{ role: "user", content: "hi" }]), [{ role: "user", content: "hi" }]);
  assert.deepEqual(parseMessages([{ role: "assistant", content: " hello " }]), [{ role: "assistant", content: " hello " }]);
  assert.equal(parseMessages([]), null);
  assert.equal(parseMessages([{ role: "user", content: "   " }]), null);
  assert.equal(parseMessages([{ role: "tool", content: "hi" }]), null);
  assert.equal(parseMessages([{ role: "user" }]), null);
  assert.equal(parseMessages("nope"), null);
  assert.equal(parseMessages(Array.from({ length: 13 }, () => ({ role: "user", content: "hi" }))), null);
});
