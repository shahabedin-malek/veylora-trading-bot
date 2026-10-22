import assert from "node:assert/strict";
import test from "node:test";
import { GET as listBots, POST as createBot } from "@/app/api/bot-builder/route";
import { POST as cloneTemplate } from "@/app/api/marketplace/route";
import { POST as publishBot } from "@/app/api/bot-builder/[botId]/publish/route";
import { DELETE as deleteBot } from "@/app/api/bot-builder/[botId]/route";

/**
 * The bot-builder routes fail closed.
 *
 * These are the four writes that change what the runner may execute — create, publish,
 * clone, delete — plus the list that states the cap. With no usable auth configuration
 * each one answers 503 naming the missing value, because a route that cannot identify the
 * account must not guess which account's bots it is speaking about.
 */

function withoutAuth(run: () => Promise<void>) {
  return async () => {
    const previous = {
      chainIds: process.env.AUTH_EVM_CHAIN_IDS,
      appBaseUrl: process.env.APP_BASE_URL,
      sessionSecret: process.env.SESSION_SECRET,
    };
    delete process.env.AUTH_EVM_CHAIN_IDS;
    delete process.env.APP_BASE_URL;
    delete process.env.SESSION_SECRET;
    try {
      await run();
    } finally {
      if (previous.chainIds === undefined) delete process.env.AUTH_EVM_CHAIN_IDS;
      else process.env.AUTH_EVM_CHAIN_IDS = previous.chainIds;
      if (previous.appBaseUrl === undefined) delete process.env.APP_BASE_URL;
      else process.env.APP_BASE_URL = previous.appBaseUrl;
      if (previous.sessionSecret === undefined) delete process.env.SESSION_SECRET;
      else process.env.SESSION_SECRET = previous.sessionSecret;
    }
  };
}

function request(path: string, method: string, body: unknown = {}) {
  const origin = "http://localhost";
  return new Request(new URL(path, origin), {
    method,
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify(body),
  }) as never;
}

test(
  "the bot-builder routes fail closed without an auth configuration",
  withoutAuth(async () => {
    const listResponse = await listBots();
    assert.equal(listResponse.status, 503);
    assert.match(((await listResponse.json()) as { error: string }).error, /APP_BASE_URL|AUTH_EVM_CHAIN_IDS|SESSION_SECRET/);

    const createResponse = await createBot(request("/api/bot-builder", "POST", { config: {} }));
    assert.equal(createResponse.status, 503);

    const publishResponse = await publishBot(request("/api/bot-builder/bot-1/publish", "POST"), {
      params: Promise.resolve({ botId: "bot-1" }),
    });
    assert.equal(publishResponse.status, 503);

    const deleteResponse = await deleteBot(request("/api/bot-builder/bot-1", "DELETE"), {
      params: Promise.resolve({ botId: "bot-1" }),
    });
    assert.equal(deleteResponse.status, 503);

    const cloneResponse = await cloneTemplate(request("/api/marketplace", "POST", { templateId: "btc-oversold-bounce" }));
    assert.equal(cloneResponse.status, 503);
  }),
);
