import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { networkCostFor, pricingRows, withdrawalFeeFor, type FeeScheduleValues } from "../src/lib/fees/table";
import { NOT_STATEMENTS, OPERATOR_NAME } from "../src/lib/public/site";

/**
 * The phase 40 assertions.
 *
 *  - A public page is public: it must not reach for a session, and it must not be wrapped in the
 *    console's shell (whose navigation is almost entirely links to signed-in surfaces).
 *  - A claim the code cannot back is a failure, not a style note. The check reads the source of
 *    every public page and the shared copy, and allows a prohibited phrase only where the sentence
 *    around it negates it ("not insured", "no uptime guarantee").
 *  - The pricing page is the fee table. The table-driven case changes a fee and the row moves with
 *    it; the source case proves the page renders `pricingRows` instead of a literal amount.
 */

const ROOT = process.cwd();
const PUBLIC_DIR = join(ROOT, "src/app/(public)");

function filesUnder(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

function sources(): { path: string; text: string }[] {
  return filesUnder(PUBLIC_DIR)
    .filter((path) => path.endsWith(".tsx"))
    .map((path) => ({ path: relative(ROOT, path), text: readFileSync(path, "utf8") }));
}

test("every public page is reachable without a session and outside the console shell", () => {
  const pages = sources().filter((file) => file.path.endsWith("page.tsx"));
  assert.ok(pages.length >= 7, `expected the public pages on disk, found ${pages.length}`);

  for (const page of pages) {
    assert.doesNotMatch(page.text, /requireUser|getCurrentUser|requireSitePermission|requireAdmin\b/, `${page.path} must not need a session`);
    assert.doesNotMatch(page.text, /from "next\/headers"/, `${page.path} must not read cookies`);
    assert.doesNotMatch(page.text, /TerminalShell/, `${page.path} must use the public shell, not the console's`);
  }

  const layout = sources().find((file) => file.path.endsWith("layout.tsx"));
  assert.ok(layout, "the public group has its own layout");
  assert.match(layout.text, /PublicShell/, "the group layout renders the public chrome");
});

test("no public page makes a claim the code cannot back", () => {
  const sharedCopy = readFileSync(join(ROOT, "src/lib/public/site.ts"), "utf8");
  const corpus = [...sources().map((file) => ({ path: file.path, text: file.text })), { path: "src/lib/public/site.ts", text: sharedCopy }];

  // A phrase that may only appear when the sentence denies it.
  const prohibited: { pattern: RegExp; why: string }[] = [
    { pattern: /\bguarantee(s|d)?\b/i, why: "no guarantee can be made by this code" },
    { pattern: /\binsured\b/i, why: "nothing in this deployment is insured" },
    { pattern: /\bsegregated\b/i, why: "no segregated account exists" },
    { pattern: /\brisk[- ]free\b/i, why: "nothing here is risk-free" },
    { pattern: /\b(apy|annual(ised|ized) return)\b/i, why: "no yield is offered" },
    { pattern: /\b\d+(\.\d+)?\s*%\s*(return|profit|apy|yield)\b/i, why: "no return figure is claimed" },
    { pattern: /\buptime\b/i, why: "no uptime figure or promise exists" },
  ];
  const negation = /\b(not|no|never|cannot|does not|isn't|without)\b/i;

  for (const file of corpus) {
    const lines = file.text.split("\n");
    for (const [index, line] of lines.entries()) {
      for (const rule of prohibited) {
        if (!rule.pattern.test(line)) continue;
        // JSX wraps a sentence across lines, so the negation can sit on the line above
        // ("it is not an" / "uptime guarantee"). The sentence is the unit, not the line.
        const sentence = `${lines[index - 1] ?? ""} ${line}`;
        assert.ok(
          negation.test(sentence),
          `${file.path}:${index + 1} uses "${rule.pattern.source.replace(/\\b/g, "")}" without denying it — ${rule.why}: ${line.trim()}`,
        );
      }
    }
  }
});

test("the pricing page is the fee table, not a copy of it", () => {
  const schedule: FeeScheduleValues = {
    effectiveFrom: "2026-01-01T00:00:00.000Z",
    withdrawalFees: { USDT: "1.5", ETH: "0.002" },
    networkCosts: { USDT: "0.5", ETH: "0.0004" },
    performanceFeePercent: "20",
    tradingFeeBps: "10",
    spreadBps: "0",
    slippageBps: "0",
    fundingBpsPerDay: "0",
    tiers: [],
  };

  const rows = pricingRows(schedule, { assets: ["USDT", "ETH"], decimals: { USDT: 6, ETH: 18 } });
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.fee, withdrawalFeeFor(schedule, row.asset), `${row.asset}'s fee is the table's`);
    assert.equal(row.networkCost, networkCostFor(schedule, row.asset), `${row.asset}'s network cost is the table's`);
  }

  // Change one fee and the row follows, which is the property the page depends on.
  const raised = pricingRows({ ...schedule, withdrawalFees: { ...schedule.withdrawalFees, USDT: "2.5" } }, {
    assets: ["USDT"],
    decimals: { USDT: 6 },
  });
  assert.equal(raised[0]?.fee, "2.5");

  const page = sources().find((file) => file.path.endsWith("pricing/page.tsx"));
  assert.ok(page, "the pricing page is in the public group");
  assert.match(page.text, /pricingRows/, "the page renders the table's own rows");
  assert.match(page.text, /readEffectiveFeeSchedule/, "the page reads the stored version at request time");
  assert.doesNotMatch(page.text, /feeLabel:\s*"/, "no fee amount is written into the page");
});

test("sign-in lands in the console, and the console is not reachable from the public side by accident", () => {
  // `/` stopped being the console when the public pages landed, and a redirect left behind at
  // "/" silently drops a signed-in person on the landing page with no navigation. Both halves
  // are asserted: the destination after sign-in, and the destination of the link a visitor on
  // the login page can press (which must be public, or it bounces back to `/login`).
  const loginForm = readFileSync(join(ROOT, "src/app/login/login-form.tsx"), "utf8");
  assert.match(loginForm, /CONSOLE_HREF/, "sign-in navigates to the console constant");
  assert.doesNotMatch(loginForm, /replace\([^)]*: "\/"/, "sign-in must not send a returning account to the landing page");

  const loginPage = readFileSync(join(ROOT, "src/app/login/page.tsx"), "utf8");
  const backLink = /href="([^"]+)">← Back to the ([^<]+)</.exec(loginPage);
  assert.ok(backLink, "the login page offers a way back");
  assert.equal(backLink[1], "/", "a visitor without a session goes back to the public page");
  assert.equal(backLink[2], "front page", "and the link says where it goes");
});

test("the legal pages name the operator and repeat what the product is not", () => {
  assert.equal(OPERATOR_NAME, "Veylora");
  assert.ok(NOT_STATEMENTS.length >= 3);
  assert.ok(NOT_STATEMENTS.some((statement) => /not a bank/i.test(statement)), "the operator is not a bank/broker/exchange");

  const legal = ["terms", "privacy", "risk", "faq"].map((name) => {
    const found = sources().find((file) => file.path.endsWith(`(public)/${name}/page.tsx`));
    assert.ok(found, `${name} page exists`);
    return found;
  });
  for (const page of legal) {
    assert.match(page.text, /@\/lib\/public\/site/, `${page.path} reads the shared copy rather than restating it`);
  }

  const terms = legal[0]!;
  assert.match(terms.text, /NOT_STATEMENTS\.map/, "the terms repeat the not-statements verbatim");
  assert.match(terms.text, /not yet named/i, "the terms state that no jurisdiction is named");
});
