/**
 * A deterministic wallet, injected the way a browser extension announces itself.
 *
 * The page discovers `window.ethereum`, reads the chain, asks for an account and
 * calls `personal_sign`. This provider does all four with a published test key
 * held in the Node process: the browser is given a signing function, never the
 * key, and the server still recovers the signer from the signature. That is why
 * this is the same sign-in path a person takes rather than a session minted
 * behind the UI's back.
 */
import { expect, type Page } from "@playwright/test";
import { E2E_CHAIN_ID_HEX, E2E_CONTROL_URL, E2E_OWNER, E2E_TOKEN } from "../config";

export type TestWallet = typeof E2E_OWNER;

export async function installWallet(
  page: Page,
  account: TestWallet,
  options: { rejectSignature?: boolean } = {},
): Promise<void> {
  await page.exposeFunction("__e2eSignMessage", async (message: string) => account.signMessage({ message }));
  await page.addInitScript(
    ({ address, chainIdHex, rejectSignature }) => {
      let chainId = chainIdHex;
      const provider = {
        isMetaMask: true,
        async request({ method, params }: { method: string; params?: unknown[] }) {
          switch (method) {
            case "eth_chainId":
              return chainId;
            case "net_version":
              return String(Number.parseInt(chainId, 16));
            case "eth_accounts":
            case "eth_requestAccounts":
              return [address];
            case "personal_sign": {
              if (rejectSignature) {
                const rejection = new Error("MetaMask Tx Signature: User denied message signature.");
                (rejection as Error & { code?: number }).code = 4001;
                throw rejection;
              }
              const message = Array.isArray(params) ? params[0] : null;
              if (typeof message !== "string") throw new Error("No message to sign.");
              return await (window as unknown as { __e2eSignMessage: (message: string) => Promise<string> }).__e2eSignMessage(
                message,
              );
            }
            case "wallet_switchEthereumChain": {
              const requested = Array.isArray(params) ? params[0] : null;
              if (requested && typeof requested === "object" && typeof (requested as { chainId?: unknown }).chainId === "string") {
                chainId = (requested as { chainId: string }).chainId;
              }
              return null;
            }
            default: {
              const unsupported = new Error(`The test wallet does not implement ${method}.`);
              (unsupported as Error & { code?: number }).code = 4200;
              throw unsupported;
            }
          }
        },
        on() {},
        removeListener() {},
      };
      Object.defineProperty(window, "ethereum", { value: provider, configurable: true });
    },
    { address: account.address, chainIdHex: E2E_CHAIN_ID_HEX, rejectSignature: options.rejectSignature === true },
  );
}

/** Sign in through the real page and wait until it has left `/login`. */
export async function signIn(page: Page, account: TestWallet, options: { rejectSignature?: boolean } = {}): Promise<void> {
  await installWallet(page, account, options);
  await page.goto("/login");
  await page.getByRole("button", { name: /SIGN IN WITH METAMASK/i }).click();
  if (options.rejectSignature) {
    // Scoped to the form: Next also renders an empty route-announcer alert.
    await expect(page.locator(".login-error")).toContainText(
      "The signature request was rejected in your wallet, so nothing was signed and no session was created.",
    );
    await expect(page).toHaveURL(/\/login$/);
    return;
  }
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 45_000 });
}

/** Clear the mock chain between specs. */
export async function resetChain(): Promise<void> {
  const response = await fetch(`${E2E_CONTROL_URL}/reset`, { method: "POST" });
  expect(response.ok, "the mock chain could not be reset").toBeTruthy();
}

/** Place one ERC-20 transfer on the mock chain, addressed to a deposit address. */
export async function placeMockDeposit(input: {
  to: string;
  token?: string;
  amount?: string;
}): Promise<{ transactionHash: string }> {
  const response = await fetch(`${E2E_CONTROL_URL}/deposit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      to: input.to,
      token: input.token ?? E2E_TOKEN.address,
      amount: input.amount ?? "100000000",
    }),
  });
  const body = (await response.json()) as { transactionHash?: string; error?: string };
  expect(response.ok, body.error ?? "the mock deposit could not be placed").toBeTruthy();
  return { transactionHash: body.transactionHash ?? "" };
}
