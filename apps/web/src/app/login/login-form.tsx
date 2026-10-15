"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { LoaderCircle, LockKeyhole, Wallet } from "lucide-react";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { useAccount, useSignMessage, useSwitchChain } from "wagmi";
import { describeAcceptedChains } from "@/lib/auth/chain-labels";
import { signInWithEvmWallet } from "@/lib/auth/evm-wallet-sign-in";

type AuthConfigResponse = {
  enabled: boolean;
  allowedChainIds: number[];
  reason: string | null;
};

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json().catch(() => null);
  if (!value || typeof value !== "object") return {};
  return value as Record<string, unknown>;
}

export default function LoginForm() {
  const router = useRouter();
  const { address, chainId, isConnected } = useAccount();
  const { openConnectModal } = useConnectModal();
  const { signMessageAsync } = useSignMessage();
  const { switchChainAsync } = useSwitchChain();
  const [configuration, setConfiguration] = useState<AuthConfigResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetch("/api/auth/config", { cache: "no-store", credentials: "same-origin" })
      .then(async (response) => {
        const value = await readJson(response);
        if (!response.ok) throw new Error("Authentication configuration is unavailable.");
        if (active) {
          setConfiguration({
            enabled: value.enabled === true,
            allowedChainIds: Array.isArray(value.allowedChainIds)
              ? value.allowedChainIds.filter((chainId): chainId is number => typeof chainId === "number")
              : [],
            reason: typeof value.reason === "string" ? value.reason : null,
          });
        }
      })
      .catch(() => {
        if (active) setError("Authentication status is unavailable.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, []);

  async function signIn() {
    setError(null);
    setBusy(true);

    try {
      if (!configuration?.enabled) throw new Error(configuration?.reason ?? "Wallet sign-in is not enabled.");
      if (!isConnected || !address) {
        if (!openConnectModal) throw new Error("No EVM wallet connector is available.");
        openConnectModal();
        return;
      }
      let signingChainId = chainId;
      if (!signingChainId || !configuration.allowedChainIds.includes(signingChainId)) {
        if (configuration.allowedChainIds.length !== 1) {
          throw new Error(`Your wallet is on an unsupported network. ${describeAcceptedChains(configuration.allowedChainIds)}`);
        }
        signingChainId = configuration.allowedChainIds[0];
        await switchChainAsync({ chainId: signingChainId });
      }
      await signInWithEvmWallet({
        address,
        chainId: signingChainId,
        allowedChainIds: configuration.allowedChainIds,
        signMessage: (message) => signMessageAsync({ message }),
      });
      router.replace("/");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Wallet sign-in failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-form">
      <div className="login-identity-state">
        <span className="state-dot state-dot--muted" aria-hidden="true" />
        <span>{loading ? "CHECKING AUTH STATUS" : configuration?.enabled ? "EVM SIGN-IN AVAILABLE" : "EVM SIGN-IN DISABLED"}</span>
      </div>

      <button className="login-button" type="button" disabled={loading || busy || !configuration?.enabled} onClick={signIn}>
        {busy ? <LoaderCircle className="login-spinner" aria-hidden="true" size={17} /> : <Wallet aria-hidden="true" size={17} />}
        <span>{busy ? "VERIFYING WALLET" : isConnected && address ? `SIGN IN · ${address.slice(0, 6)}...${address.slice(-4)}` : "CONNECT EVM WALLET"}</span>
      </button>

      {!loading && !configuration?.enabled && (
        <div className="login-unavailable" role="status">
          <LockKeyhole aria-hidden="true" size={15} />
          <span>{configuration?.reason ?? "No EVM authentication chain is configured."}</span>
        </div>
      )}
      {error && <p className="login-error" role="alert">{error}</p>}
    </div>
  );
}
