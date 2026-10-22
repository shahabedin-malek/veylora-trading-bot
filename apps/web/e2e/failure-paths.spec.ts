/**
 * The four refusals a person can actually meet, each asserted as the sentence on
 * screen rather than as a status code.
 *
 * They use distinct wallets: a refused signature must not leave a session behind;
 * the deposit and withdrawal cases need an account with no history; and the risk
 * case needs the seeded OWNER because the limit is admin data.
 */
import { expect, test } from "./fixtures/console";
import {
  E2E_DEPOSITOR,
  E2E_NETWORK_SLUG,
  E2E_OWNER,
  E2E_WITHDRAWAL_DESTINATION,
  E2E_WITHDRAWER,
  E2E_WRONG_TOKEN,
} from "./config";
import { placeMockDeposit, resetChain, signIn } from "./fixtures/wallet";

test.describe("failure paths", () => {
  test("sign-in step: a rejected signature says nothing was signed", async ({ page }) => {
    await resetChain();
    await signIn(page, E2E_DEPOSITOR, { rejectSignature: true });
    const alert = page.locator(".login-error");
    await expect(alert).toContainText(
      "The signature request was rejected in your wallet, so nothing was signed and no session was created.",
    );
    await expect(alert).toContainText("SIGNATURE_REJECTED");
    await expect(page).toHaveURL(/\/login$/);
  });

  test("deposit step: another token is recorded for a valuation and never auto-credited", async ({ page }) => {
    await resetChain();
    await signIn(page, E2E_DEPOSITOR);
    await page.goto("/trade");

    const deposits = page.locator('[aria-labelledby="deposits-title"]');
    const address = deposits.locator(".deposit-address__value code");
    await expect(address).toBeVisible();
    const to = (await address.textContent())?.trim() ?? "";
    expect(to).toMatch(/^0x[0-9a-fA-F]{40}$/);

    await placeMockDeposit({ to, token: E2E_WRONG_TOKEN.address, amount: "5000000" });
    await deposits.getByRole("button", { name: /CHECK NOW/i }).click();

    // Any token is accepted, but only the configured one is priced by the code: the
    // arrival is recorded for the owner to credit at a USDT value, and the balance does
    // not move on its own.
    await expect(deposits.locator(".deposit-item__reason")).toContainText(
      "is not the token this deployment configures",
    );
    await expect(deposits.locator(".deposit-item__reason")).toContainText("TOKEN AWAITING VALUATION");
    await expect(deposits.locator(".deposit-item__reason")).toContainText("USDT value");
    await expect(deposits.locator(".deposit-totals")).toContainText("Nothing credited yet");
  });

  test("order step: a risk cap refuses the order with the limit and the value it saw", async ({ page }) => {
    await resetChain();
    await signIn(page, E2E_OWNER);
    await page.goto("/admin/risk");

    const original = (await page.evaluate(async () => {
      const response = await fetch("/api/admin/risk-policy", { cache: "no-store" });
      if (!response.ok) throw new Error(`Risk policy read failed: ${response.status}`);
      return response.json();
    })) as Record<string, unknown>;

    const updated = { ...original, maxOrderNotionalUsd: "250" };
    try {
      const saved = await page.evaluate(async (body) => {
        const response = await fetch("/api/admin/risk-policy", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        return { status: response.status, body: await response.json() };
      }, updated);
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);

      await page.goto("/trade");
      const ticket = page.locator('form[aria-label="Order ticket"]');
      await expect(ticket).toBeVisible();
      await ticket.locator("select").nth(0).selectOption("BTC-USD");
      await ticket.locator("select").nth(1).selectOption("BUY");
      await ticket.locator("select").nth(2).selectOption("MARKET");
      await ticket.locator("select").nth(3).selectOption("paper");
      await ticket.locator('input[inputmode="decimal"]').nth(0).fill("0.01");
      await ticket.locator('input[inputmode="decimal"]').nth(1).fill("1000");
      await ticket.locator('input[inputmode="decimal"]').nth(2).fill("1000");
      await ticket.getByRole("button", { name: /Submit paper order/i }).click();

      await expect(page.locator(".orders-panel__error")).toContainText(
        "Refused by a limit you set: Max notional per order 250.00 — this order would make it 1000.00.",
      );
    } finally {
      await page.evaluate(async (body) => {
        await fetch("/api/admin/risk-policy", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      }, original);
    }
  });

  test("withdrawal step: a request above the spendable balance is refused and holds nothing", async ({ page }) => {
    await resetChain();
    await signIn(page, E2E_WITHDRAWER);
    await page.goto("/trade");

    const withdrawals = page.locator('[aria-labelledby="withdrawals-title"]');
    await expect(withdrawals.locator(".withdraw-form")).toBeVisible();
    await withdrawals.locator(".withdraw-form select").selectOption(E2E_NETWORK_SLUG);
    await withdrawals.locator('.withdraw-form input[inputmode="decimal"]').fill("1");
    await withdrawals.locator('.withdraw-form input[placeholder="0x…"]').fill(E2E_WITHDRAWAL_DESTINATION);
    await withdrawals.getByRole("button", { name: /REQUEST WITHDRAWAL/i }).click();

    const refusal = withdrawals.locator(".withdraw-refusal").filter({ hasText: "INSUFFICIENT_BALANCE" });
    await expect(refusal).toContainText("The account can spend 0 of 1000000 USDT minor units requested");
    await expect(refusal).toContainText("the withdrawal was refused and nothing was held");
  });
});
