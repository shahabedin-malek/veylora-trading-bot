/**
 * The canonical journey, in a real browser against a seeded local server.
 *
 * Every step is named through `test.step`, so a failure reads as "the deposit
 * was not credited" rather than as an anonymous click timeout. The runner step
 * deliberately closes the browser context and reopens a new one from saved
 * cookies: if the strategy only stayed alive because a page was polling, that
 * step would fail.
 */
import { expect, test } from "./fixtures/console";
import {
  E2E_BASE_URL,
  E2E_CRON_SECRET,
  E2E_NETWORK_SLUG,
  E2E_OWNER,
  E2E_WITHDRAWAL_DESTINATION,
} from "./config";
import { placeMockDeposit, resetChain, signIn } from "./fixtures/wallet";

type ActivationPayload = {
  view?: {
    intent?: string;
    stateLabel?: string;
    lastPass?: { runCount?: number; at?: string | null; outcome?: string | null };
    runner?: { scheduled?: boolean };
  };
};

async function readActivation(page: import("@playwright/test").Page): Promise<ActivationPayload> {
  return (await page.evaluate(async () => {
    const response = await fetch("/api/strategies/activate", { cache: "no-store", credentials: "same-origin" });
    return response.json();
  })) as ActivationPayload;
}

test.describe("canonical journey", () => {
  test("sign in → deposit credited → balances and history → start smart trading → runner survives a closed browser → withdrawal confirmed", async ({
    page,
    browser,
    request,
    consoleLogs,
  }, testInfo) => {
    test.setTimeout(180_000);

    await test.step("sign in with the seeded owner wallet", async () => {
      await resetChain();
      await signIn(page, E2E_OWNER);
      // The console, not the public landing page: `/` became the signed-out landing
      // page when the public pages landed, and sign-in sends a returning account to
      // `/terminal`. Asserting the console's own navigation is what proves the
      // session reached the application rather than a marketing page.
      await expect(page).toHaveURL(new RegExp(`${E2E_BASE_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/terminal$`));
      await expect(page.getByRole("link", { name: /TRADE/i }).first()).toBeVisible();
    });

    let depositAddress = "";

    await test.step("read the deposit address issued for this account", async () => {
      await page.goto("/trade");
      const address = page.locator(".deposit-address__value code");
      await expect(address).toBeVisible();
      depositAddress = (await address.textContent())?.trim() ?? "";
      expect(depositAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    });

    await test.step("credit a mock chain transfer and see it credited once", async () => {
      await placeMockDeposit({ to: depositAddress, amount: "100000000" });
      const deposits = page.locator('[aria-labelledby="deposits-title"]');
      await deposits.getByRole("button", { name: /CHECK NOW/i }).click();
      await expect(deposits.locator(".deposit-totals")).toContainText(/100(?:\.0+)? USDT/);
      await expect(deposits.locator(".deposit-run")).toContainText(/1 credited/);
      await expect(deposits.locator(".deposit-item")).toContainText(/CREDITED/);
    });

    await test.step("see the balance and the movement in account history", async () => {
      await page.goto("/account");
      const balance = page.locator(".account-balance-card").filter({ hasText: "USDT" });
      await expect(balance).toBeVisible();
      await expect(balance).toContainText(/100(?:\.0+)?/);
      const history = page.locator('[aria-labelledby="account-history-title"]');
      await expect(history.locator("tbody tr").first()).toBeVisible();
      await expect(history).toContainText(/USDT/);
      await expect(history).toContainText(/100(?:\.0+)?/);
    });

    let runCountBefore = 0;

    await test.step("press the visible start control", async () => {
      await page.goto("/trade");
      const smart = page.locator(".smart-trading");
      await expect(smart).toBeVisible();
      await smart.locator(".smart-trading__start").click();
      await expect(page.getByText(/Smart trading started for this account/)).toBeVisible();
      const activation = await readActivation(page);
      expect(activation.view?.intent).toBe("RUNNING");
      runCountBefore = activation.view?.lastPass?.runCount ?? 0;
    });

    const storageState = await page.context().storageState();

    await test.step("close the browser context and let the runner take its pass", async () => {
      await page.context().close();
      const cron = await request.get("/api/cron/strategy-activation", {
        headers: { Authorization: `Bearer ${E2E_CRON_SECRET}` },
      });
      expect(cron.status()).toBe(200);
      const summary = (await cron.json()) as {
        jobsRan?: number;
        heartbeats?: { jobId: string; status: string; summary: string }[];
      };
      const heartbeat = summary.heartbeats?.find((entry) => entry.jobId === "strategy-activation");
      expect(heartbeat, "the strategy job did not report a heartbeat").toBeTruthy();
      expect(heartbeat?.status).toBe("worked");
      expect(heartbeat?.summary).toMatch(/activation/);
    });

    const context = await browser.newContext({ baseURL: E2E_BASE_URL, storageState, viewport: { width: 1440, height: 1000 } });
    const pageAfter = await context.newPage();
    const afterLines: string[] = [];
    pageAfter.on("console", (message) => afterLines.push(`[${message.type()}] ${message.text()}`));
    pageAfter.on("pageerror", (error) => afterLines.push(`[pageerror] ${error.stack ?? error.message}`));

    try {
      await test.step("reopen the console and see the runner advanced while it was closed", async () => {
        await pageAfter.goto("/trade");
        const smart = pageAfter.locator(".smart-trading");
        await expect(smart).toBeVisible();
        const activation = await readActivation(pageAfter);
        expect(activation.view?.intent).toBe("RUNNING");
        expect(activation.view?.lastPass?.at, "the runner recorded no pass while the browser was closed").toBeTruthy();
        expect(activation.view?.lastPass?.runCount ?? 0).toBeGreaterThan(runCountBefore);
      });

      await test.step("request a withdrawal and see it confirmed by the simulated network", async () => {
        const withdrawals = pageAfter.locator('[aria-labelledby="withdrawals-title"]');
        await expect(withdrawals.locator(".withdraw-form")).toBeVisible();
        await withdrawals.locator(".withdraw-form select").selectOption(E2E_NETWORK_SLUG);
        await withdrawals.locator('.withdraw-form input[inputmode="decimal"]').fill("25");
        await withdrawals.locator('.withdraw-form input[placeholder="0x…"]').fill(E2E_WITHDRAWAL_DESTINATION);
        await withdrawals.getByRole("button", { name: /REQUEST WITHDRAWAL/i }).click();
        await expect(withdrawals.locator(".withdraw-notice")).toContainText(/was accepted and the amount is now held/);

        await withdrawals.locator(".withdraw-actions").getByRole("button", { name: /CHECK NOW/i }).click();
        const row = withdrawals.locator(".withdraw-item").filter({ hasText: "25" }).first();
        await expect(row).toBeVisible();
        await expect(row).toContainText(/CONFIRMED/, { timeout: 30_000 });
        await expect(row.locator(".withdraw-badge")).toContainText("SIMULATED");
      });
    } finally {
      await testInfo.attach("console-after-context-close.log", {
        body: afterLines.join("\n") || "(no console output)",
        contentType: "text/plain",
      });
      await context.close();
    }

    // A visible, ordered record of what the person just did. Two facts and no
    // assertion: the screenshot is for the proof, not a substitute for one.
    expect(consoleLogs.filter((line) => line.includes("pageerror"))).toEqual([]);
  });
});
