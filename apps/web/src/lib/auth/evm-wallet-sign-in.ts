"use client";

import { describeAcceptedChains } from "@/lib/auth/chain-labels";

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json().catch(() => null);
  if (!value || typeof value !== "object") return {};
  return value as Record<string, unknown>;
}

export async function signInWithEvmWallet(
  input: {
    address: string;
    chainId: number;
    allowedChainIds: readonly number[];
    signMessage: (message: string) => Promise<string>;
  },
): Promise<void> {
  const { address, chainId, allowedChainIds, signMessage } = input;
  if (!allowedChainIds.includes(chainId)) {
    throw new Error(`This wallet network is not available for sign-in. ${describeAcceptedChains(allowedChainIds)}`);
  }

  const nonceResponse = await fetch("/api/auth/nonce", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address, chainId }),
  });
  const noncePayload = await readJson(nonceResponse);
  if (!nonceResponse.ok || typeof noncePayload.message !== "string") {
    throw new Error(typeof noncePayload.error === "string" ? noncePayload.error : "Could not start wallet sign-in.");
  }

  const signature = await signMessage(noncePayload.message);
  if (typeof signature !== "string") throw new Error("The wallet did not return a signature.");

  const verifyResponse = await fetch("/api/auth/verify", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: noncePayload.message, signature }),
  });
  const verification = await readJson(verifyResponse);
  if (!verifyResponse.ok || verification.authenticated !== true) {
    throw new Error(typeof verification.error === "string" ? verification.error : "Wallet sign-in failed.");
  }
}