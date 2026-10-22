import assert from "node:assert/strict";
import test from "node:test";
import { emptyToolRecord, composeAnswer } from "@/lib/assistant/citations";
import {
  ASSISTANT_TOOLS,
  createAssistantToolExecutor,
  describeNonPaperRouting,
  sanitiseArguments,
  type AssistantToolDeps,
  type BalanceRead,
} from "@/lib/assistant/tools";

/**
 * The tool layer's own guarantees, with no model and no network.
 *
 * The two things this file exists to prove are the two the phase names as acceptance
 * criteria: a tool reads with the *session's* identity and nothing else, and a tool that
 * fails produces a stated failure rather than a plausible number. Both are asserted at the
 * reader boundary — the function the executor calls — so a future change that quietly
 * passes a model-supplied id into a query would fail here.
 */

const NOW = new Date("2026-10-18T03:00:00.000Z");

function balanceRead(asset: string, balance: string): BalanceRead {
  return { readAt: NOW.toISOString(), balances: [{ asset, balance, available: balance, bucket: "AVAILABLE", label: `Available ${asset}`, entries: 2 }] };
}

/** A dependency set where every account reader records the id it was handed. */
function spyingDeps(seen: string[]): Partial<AssistantToolDeps> {
  return {
    balances: async (userId) => {
      seen.push(userId);
      return balanceRead("USDT", "20.00");
    },
    statement: async (userId) => {
      seen.push(userId);
      return { from: NOW.toISOString(), to: NOW.toISOString(), readAt: NOW.toISOString(), totals: [], lines: [], lineCount: 0 };
    },
    positions: async (userId) => {
      seen.push(userId);
      return { readAt: NOW.toISOString(), positions: [], note: null };
    },
    openOrders: async (userId) => {
      seen.push(userId);
      return { readAt: NOW.toISOString(), open: [] };
    },
    alerts: async (userId) => {
      seen.push(userId);
      return { readAt: NOW.toISOString(), alerts: [] };
    },
  };
}

test("every tool declares the arguments it accepts, and nothing else reaches a reader", () => {
  for (const tool of ASSISTANT_TOOLS) {
    const declared = Object.keys(tool.parameters.properties);
    const sanitised = sanitiseArguments(tool.name, {
      userId: "someone-else",
      accountId: "someone-else",
      databaseUrl: "postgres://elsewhere",
      symbol: "BTC-USD",
      query: "  bitcoin  ",
    });
    assert.ok(sanitised, `${tool.name} is a tool this build knows`);
    for (const key of Object.keys(sanitised)) {
      assert.ok(declared.includes(key), `${tool.name} kept only declared arguments, not ${key}`);
    }
    assert.equal(sanitised.userId, undefined, `${tool.name} drops a model-supplied userId`);
    assert.equal(sanitised.accountId, undefined);
    // Whitespace is trimmed rather than passed on: a symbol with a trailing space is a
    // different string to every lookup downstream.
    if (declared.includes("query")) assert.equal(sanitised.query, "bitcoin");
  }
  assert.equal(sanitiseArguments("not_a_tool", {}), null);
});

test("the trade tool has no execution argument, so the model cannot ask for live", () => {
  const paper = ASSISTANT_TOOLS.find((tool) => tool.name === "place_paper_order");
  assert.ok(paper);
  assert.deepEqual(Object.keys(paper.parameters.properties).sort(), ["limitPrice", "market", "orderType", "quantity", "side"]);
  assert.match(paper.description, /PAPER/);
  assert.match(paper.description, /no real funds move/);
  const smuggled = sanitiseArguments("place_paper_order", { market: "BTC-USD", side: "BUY", quantity: "0.01", execution: "live", venue: "binance" });
  assert.deepEqual(smuggled, { market: "BTC-USD", side: "BUY", quantity: "0.01" });
  assert.match(describeNonPaperRouting("live"), /only places paper orders/);
  assert.match(describeNonPaperRouting("live"), /live execution off in \/admin\/risk/);
});

test("account tools read with the session's id and never with an argument's", async () => {
  const seen: string[] = [];
  const record = emptyToolRecord();
  const execute = createAssistantToolExecutor({ userId: "owner-1", now: NOW, record }, spyingDeps(seen));

  const result = await execute("get_account_balance", { userId: "victim-2", accountId: "victim-2" });
  assert.deepEqual(result, { ok: true, data: balanceRead("USDT", "20.00") });
  assert.deepEqual(seen, ["owner-1"], "the reader saw the session's id and only that");
  assert.equal(record.citations.length, 1);
  assert.equal(record.citations[0]!.source, "ledger");
  assert.equal(record.citations[0]!.asOf, NOW.toISOString());
});

test("account tools refuse without a session and read nothing at all", async () => {
  const seen: string[] = [];
  const record = emptyToolRecord();
  const execute = createAssistantToolExecutor({ userId: null, now: NOW, record }, spyingDeps(seen));

  for (const name of ["get_account_balance", "get_ledger_history", "get_open_positions", "list_open_orders", "list_market_alerts", "search_research", "extract_research", "search_social_posts"]) {
    const result = (await execute(name, { limit: 5 })) as { ok: boolean; error: string };
    assert.equal(result.ok, false, `${name} refuses without a session`);
    assert.match(result.error, /Sign in/);
  }
  assert.deepEqual(seen, [], "no account reader was called");
  assert.equal(record.citations.length, 0);
  assert.equal(record.failures.length, 8);
});

test("a public tool answers without a session, because it reads nothing that belongs to anyone", async () => {
  const record = emptyToolRecord();
  const execute = createAssistantToolExecutor({ userId: null, now: NOW, record }, {
    quote: async (symbol) => ({
      symbol,
      providerId: "coinbase-exchange",
      bid: "100.00",
      ask: "100.10",
      last: "100.05",
      priceChangePercent24h: "1.2",
      observedAt: NOW.toISOString(),
      freshness: "FRESH",
    }),
  });
  const result = (await execute("get_market_quote", { symbol: "BTC-USD" })) as { ok: boolean; data: { ask: string } };
  assert.equal(result.ok, true);
  assert.equal(result.data.ask, "100.10");
  assert.equal(record.citations.length, 1);
  assert.equal(record.citations[0]!.source, "coinbase-exchange");
  assert.equal(record.failures.length, 0);
});

test("the indicator tool reads the screener's own series and cites its close time", async () => {
  const record = emptyToolRecord();
  let asked: { symbol: string; now: Date } | null = null;
  const execute = createAssistantToolExecutor({ userId: null, now: NOW, record }, {
    indicator: async (symbol, now) => {
      asked = { symbol, now };
      return {
        symbol,
        interval: "15m",
        observedAt: "2026-10-18T02:45:00.000Z",
        providerId: "coinbase-exchange",
        rsi14: 46.9269,
        candles: 30,
      };
    },
  });

  const result = (await execute("get_market_indicator", { symbol: "BTC-USD" })) as { ok: boolean; data: { rsi14: number; interval: string } };
  assert.equal(result.ok, true);
  assert.equal(result.data.rsi14, 46.9269);
  assert.equal(result.data.interval, "15m");
  assert.deepEqual(asked, { symbol: "BTC-USD", now: NOW });
  assert.equal(record.citations.length, 1);
  assert.equal(record.citations[0]!.source, "coinbase-exchange");
  // The moment is the candle's own close, not the moment the question was asked.
  assert.equal(record.citations[0]!.asOf, "2026-10-18T02:45:00.000Z");
});

test("an unsupported symbol is refused before any reader is asked", async () => {
  const record = emptyToolRecord();
  let called = false;
  const execute = createAssistantToolExecutor({ userId: null, now: NOW, record }, {
    quote: async () => {
      called = true;
      throw new Error("should not be reached");
    },
  });
  const result = (await execute("get_market_quote", { symbol: "DOGE-EUR" })) as { ok: boolean; error: string };
  assert.equal(result.ok, false);
  assert.match(result.error, /Unsupported public Coinbase USD symbol/);
  assert.equal(called, false);
});

test("a reader that fails becomes a stated failure, never a number", async () => {
  const record = emptyToolRecord();
  const execute = createAssistantToolExecutor({ userId: "owner-1", now: NOW, record }, {
    balances: async () => {
      throw new Error("The ledger could not be read.");
    },
  });

  const result = (await execute("get_account_balance", {})) as { ok: boolean; error: string };
  assert.equal(result.ok, false);
  assert.equal(result.error, "The ledger could not be read.");
  assert.equal(record.citations.length, 0);
  assert.deepEqual(record.failures, [{ tool: "get_account_balance", label: "get_account_balance", reason: "The ledger could not be read." }]);

  // And the answer says so, in words, instead of leaving the sentence to the model.
  const answer = composeAnswer({ reply: "Your balance is 20.00 USDT.", record, question: "What is my balance?" });
  assert.match(answer.text, /Could not read: get_account_balance/);
  assert.match(answer.text, /could not read your balance/);
  assert.match(answer.text, /not estimated or substituted/);
});

test("an account question that no tool answered is stated as unread, and a market question is not", async () => {
  const empty = emptyToolRecord();
  const unread = composeAnswer({ reply: "Probably about 20 USDT.", record: empty, question: "What is my balance and my positions?" });
  assert.deepEqual(unread.missingTopics.sort(), ["balance", "positions"]);
  assert.match(unread.text, /I could not read your balance/);
  assert.match(unread.text, /I could not read your positions/);

  const answered = emptyToolRecord();
  answered.citations.push({ tool: "get_account_balance", label: "Ledger balances", source: "ledger", asOf: NOW.toISOString() });
  const market = composeAnswer({ reply: "RSI-14 is 44.5.", record: answered, question: "What is the BTC-USD RSI-14?" });
  assert.deepEqual(market.missingTopics, []);
  assert.equal(market.text, "RSI-14 is 44.5.");
});

test("the paper-trade tool reports a refusal from its own reader and never a placed order", async () => {
  const record = emptyToolRecord();
  const execute = createAssistantToolExecutor({ userId: "owner-1", now: NOW, record }, {
    paperOrder: async (userId, input) => {
      assert.equal(userId, "owner-1");
      assert.deepEqual(input, { market: "BTC-USD", side: "BUY", quantity: "0.01", orderType: "MARKET", limitPrice: null });
      return { placed: false, reason: describeNonPaperRouting("testnet") };
    },
  });

  const result = (await execute("place_paper_order", { market: "BTC-USD", side: "BUY", quantity: "0.01" })) as { ok: boolean; error: string };
  assert.equal(result.ok, false);
  assert.match(result.error, /points at testnet/);
  assert.deepEqual(record.failures, [{ tool: "place_paper_order", label: "Paper order", reason: describeNonPaperRouting("testnet") }]);
  assert.equal(record.citations.length, 0);
});

test("a placed paper order is reported as paper, with its own citation", async () => {
  const record = emptyToolRecord();
  const execute = createAssistantToolExecutor({ userId: "owner-1", now: NOW, record }, {
    paperOrder: async () => ({
      placed: true,
      venue: "dev-paper",
      market: "BTC-USD",
      side: "BUY",
      quantity: "0.01",
      outcome: "submitted",
      status: "SUBMITTED",
      orderId: "order-1",
      reason: "dev-paper accepted the order as paper-abc, and it is SUBMITTED.",
    }),
  });

  const result = (await execute("place_paper_order", { market: "BTC-USD", side: "BUY", quantity: "0.01" })) as { ok: boolean; data: { paper: boolean; note: string } };
  assert.equal(result.ok, true);
  assert.equal(result.data.paper, true);
  assert.match(result.data.note, /no real funds move/);
  assert.equal(record.citations.at(-1)!.source, "venue dev-paper");
  assert.equal(record.citations.at(-1)!.asOf, NOW.toISOString());
});

test("research is refused when the owner's switch is off, before the provider is asked", async () => {
  const record = emptyToolRecord();
  let searched = false;
  let askedKind: string | null = null;
  const execute = createAssistantToolExecutor({ userId: "owner-1", now: NOW, record }, {
    researchAccess: async (userId, kind) => {
      assert.equal(userId, "owner-1");
      askedKind = kind;
      return { allowed: false, reason: "Tavily Search is switched off in Access & Integrations." };
    },
    search: async () => {
      searched = true;
      return [];
    },
  });

  const result = (await execute("search_research", { query: "bitcoin" })) as { ok: boolean; error: string };
  assert.equal(result.ok, false, "a switched-off search is a failure, not an empty result");
  assert.match(result.error, /switched off/);
  assert.equal(askedKind, "search");
  assert.equal(searched, false, "the provider was never called");
  assert.deepEqual(record.failures, [
    { tool: "search_research", label: "search_research", reason: "Tavily Search is switched off in Access & Integrations." },
  ]);
  assert.equal(record.citations.length, 0);

  // The tools are account-scoped: the switch and the minute's budget belong to a person.
  for (const name of ["search_research", "extract_research"]) {
    assert.equal(ASSISTANT_TOOLS.find((tool) => tool.name === name)?.scope, "account", `${name} needs the session's account`);
  }
});

/** The budget the research desk enforces is the one the assistant spends from too. */
test("a refused research budget becomes a stated failure", async () => {
  const record = emptyToolRecord();
  const execute = createAssistantToolExecutor({ userId: "owner-1", now: NOW, record }, {
    researchAccess: async () => ({ allowed: false, reason: "Tavily request limit reached; try again in a minute." }),
    extract: async () => {
      throw new Error("should not be reached");
    },
  });
  const result = (await execute("extract_research", { urls: "https://example.org/a" })) as { ok: boolean; error: string };
  assert.equal(result.ok, false);
  assert.match(result.error, /try again in a minute/);
  assert.equal(record.citations.length, 0);
});

test("a SandBase search is refused before the provider when its switch is off", async () => {
  const record = emptyToolRecord();
  let asked = false;
  let accessFor: string | null = null;
  const reason = "SandBase social data is switched off in Access & Integrations.";
  const execute = createAssistantToolExecutor({ userId: "owner-1", now: NOW, record }, {
    sandbaseAccess: async (userId) => {
      accessFor = userId;
      return { allowed: false, reason };
    },
    sandbaseSocial: async () => {
      asked = true;
      throw new Error("should not be reached");
    },
  });

  const result = (await execute("search_social_posts", { topic: "bitcoin" })) as { ok: boolean; error: string };
  assert.equal(result.ok, false, "a switched-off source is a failure, not an empty list");
  assert.match(result.error, /switched off/);
  assert.equal(accessFor, "owner-1", "the budget belongs to the session's account");
  assert.equal(asked, false, "the provider was never called");
  assert.deepEqual(record.failures, [{ tool: "search_social_posts", label: "search_social_posts", reason }]);
  assert.equal(record.citations.length, 0);
  assert.equal(ASSISTANT_TOOLS.find((tool) => tool.name === "search_social_posts")?.scope, "account");
});

test("a SandBase search cites the newest post's own time, not the moment of the question", async () => {
  const record = emptyToolRecord();
  let requested: { topic: string; sort: string; limit: number } | null = null;
  const execute = createAssistantToolExecutor({ userId: "owner-1", now: NOW, record }, {
    sandbaseAccess: async () => ({ allowed: true }),
    sandbaseSocial: async (input) => {
      requested = input;
      return {
        topic: input.topic,
        sort: input.sort,
        vendor: "Twitter / X",
        model: "twitter/web/search-timeline",
        readAt: NOW.toISOString(),
        newestAt: "2026-10-18T02:30:00.000Z",
        posts: [
          {
            author: "trader",
            authorName: "A Trader",
            verified: true,
            followers: 1_500,
            text: "BTC breaking out",
            createdAt: "2026-10-18T02:30:00.000Z",
            url: "https://x.com/trader/status/1",
            engagement: { likes: 3, reposts: 1, replies: 0, views: 40 },
          },
        ],
      };
    },
  });

  const result = (await execute("search_social_posts", { topic: "bitcoin", sort: "Top", limit: 3 })) as {
    ok: boolean;
    data: { posts: unknown[] };
  };
  assert.equal(result.ok, true);
  assert.equal(result.data.posts.length, 1);
  assert.deepEqual(requested, { topic: "bitcoin", sort: "Top", limit: 3 });

  const citation = record.citations.at(-1);
  assert.ok(citation);
  assert.equal(citation.tool, "search_social_posts");
  assert.equal(citation.label, "bitcoin social posts");
  assert.equal(citation.source, "sandbase");
  assert.equal(citation.asOf, "2026-10-18T02:30:00.000Z");
  assert.match(citation.detail ?? "", /Twitter \/ X/);
  // The answer has to be able to say these are claims, not readings.
  assert.match(citation.detail ?? "", /claims/);
  assert.equal(record.failures.length, 0);
});

test("a SandBase topic outside its bounds is refused before the budget is spent", async () => {
  const record = emptyToolRecord();
  let accessed = false;
  const execute = createAssistantToolExecutor({ userId: "owner-1", now: NOW, record }, {
    sandbaseAccess: async () => {
      accessed = true;
      return { allowed: true };
    },
  });

  const empty = (await execute("search_social_posts", { topic: "   " })) as { ok: boolean; error: string };
  assert.equal(empty.ok, false);
  const long = (await execute("search_social_posts", { topic: "x".repeat(121) })) as { ok: boolean; error: string };
  assert.equal(long.ok, false);
  assert.match(long.error, /1–120 characters/);
  assert.equal(accessed, false, "no request is charged for a malformed argument");
  assert.equal(record.citations.length, 0);
});

test("an unknown tool and an unknown symbol are refused by name", async () => {
  const record = emptyToolRecord();
  const execute = createAssistantToolExecutor({ userId: "owner-1", now: NOW, record });
  const unknown = (await execute("query_the_database", {})) as { ok: boolean; error: string };
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /Unknown tool/);
});
