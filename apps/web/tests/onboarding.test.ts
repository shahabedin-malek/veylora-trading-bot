import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildOnboardingChecklist, ONBOARDING_STEPS, type OnboardingSignals } from "../src/lib/onboarding/checklist";

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The onboarding acceptance criterion: a checklist that reaches 4/4 from the
 * records of the four actions, and reaches it without a stored checkbox.
 */

const nothingDone: OnboardingSignals = {
  walletAddress: null,
  lastBalanceReadAt: null,
  paperOrders: 0,
  alerts: 0,
};

const everythingDone: OnboardingSignals = {
  walletAddress: "0x5a407Ff50d55142c36144B390972c51A768eBf8c",
  lastBalanceReadAt: new Date("2026-10-16T12:00:00.000Z"),
  paperOrders: 1,
  alerts: 1,
};

test("the checklist is the four steps the phase promises, each linking to a real surface", () => {
  assert.deepEqual(ONBOARDING_STEPS.map(({ id }) => id), ["connect-wallet", "see-balance", "paper-trade", "set-alert"]);
  for (const step of ONBOARDING_STEPS) {
    assert.ok(step.href.startsWith("/"), `${step.id} must link inside the application, got ${step.href}`);
    assert.ok(step.title.length > 0 && step.description.length > 0 && step.action.length > 0);
  }
});

/**
 * Which surface each step sends the account to, pinned. A step that links to the right
 * page but the wrong section of it is still a step the account cannot finish: the alert
 * step pointed at `/#activity`, the *audit stream's* anchor on the home page, so the
 * click landed one section above the create-alert form. This is the assertion that keeps
 * that from coming back, and the browser pass is what found it the first time.
 */
test("each step links to the surface that completes it, at the section that holds the control", () => {
  assert.deepEqual(
    ONBOARDING_STEPS.map(({ id, href }) => [id, href]),
    [
      ["connect-wallet", "/login"],
      ["see-balance", "/#portfolio"],
      ["paper-trade", "/trade"],
      ["set-alert", "/#alerts"],
    ],
  );
});

/**
 * The alert step's `#alerts` anchor has to exist on the page it points at, or the deep
 * link silently becomes a plain link to the top of the page — nothing in the app would
 * report it. This repo has no DOM harness (the pages are asserted over HTTP in the
 * click-path and in the route sweep), so the contract between the two files is read from
 * the source, the way `seed-plan.test.ts` reads the seed.
 */
test("the alerts anchor the checklist names exists on the surface it points at", () => {
  const panel = readFileSync(resolve(APP_DIR, "src/components/market-alerts-panel.tsx"), "utf8");
  const anchors = [...panel.matchAll(/<section[^>]*\bid="([^"]+)"/g)].map(([, id]) => id);
  assert.ok(
    anchors.includes("alerts"),
    `the Market alerts panel must carry id="alerts", found ${anchors.length ? anchors.join(", ") : "no section ids"}`,
  );
});

test("a fresh account starts at zero of four, with the first step as the next one", () => {
  const checklist = buildOnboardingChecklist(nothingDone);
  assert.equal(checklist.completed, 0);
  assert.equal(checklist.total, 4);
  assert.equal(checklist.complete, false);
  assert.equal(checklist.nextStep?.id, "connect-wallet");
  // Nothing is ticked for a surface that has no record behind it.
  assert.equal(checklist.steps.every((step) => !step.complete), true);
  assert.equal(checklist.steps.every((step) => step.evidence.length > 0), true);
});

test("each record moves exactly one step, and a balance read is what moves its own", () => {
  const signals: OnboardingSignals = { ...nothingDone, walletAddress: "0x1111111111111111111111111111111111111111" };
  assert.equal(buildOnboardingChecklist(signals).completed, 1);

  const withBalance = { ...signals, lastBalanceReadAt: new Date("2026-10-16T12:00:00.000Z") };
  assert.equal(buildOnboardingChecklist(withBalance).completed, 2);
  assert.equal(buildOnboardingChecklist(withBalance).steps.find(({ id }) => id === "see-balance")?.complete, true);

  const withOrder = { ...withBalance, paperOrders: 2 };
  assert.equal(buildOnboardingChecklist(withOrder).completed, 3);

  const withAlert = { ...withOrder, alerts: 3 };
  assert.equal(buildOnboardingChecklist(withAlert).completed, 4);
});

test("a completed account reaches four of four with nothing left over", () => {
  const checklist = buildOnboardingChecklist(everythingDone);
  assert.equal(checklist.completed, 4);
  assert.equal(checklist.total, 4);
  assert.equal(checklist.complete, true);
  assert.equal(checklist.nextStep, null);
  assert.equal(checklist.steps.every((step) => step.complete), true);
});

test("a balance provider that read nothing leaves the step open", () => {
  // The signals are what the database says: no completed read means no step, and
  // the page — not this model — explains why the read has not happened.
  const checklist = buildOnboardingChecklist({ ...everythingDone, lastBalanceReadAt: null });
  assert.equal(checklist.completed, 3);
  assert.equal(checklist.complete, false);
  assert.equal(checklist.nextStep?.id, "see-balance");
  assert.match(checklist.nextStep?.evidence ?? "", /No balance has been read/);
});
