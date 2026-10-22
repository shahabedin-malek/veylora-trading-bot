"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useSyncExternalStore, type FormEvent } from "react";
import { AlertTriangle, CheckCircle2, Download, LoaderCircle, LockKeyhole, RefreshCw, Wallet } from "lucide-react";
import WalletConnectPairing from "@/components/wallet-connect-pairing";
import { describeAcceptedChains, evmChainLabel } from "@/lib/auth/chain-labels";
import {
  completeSignInVerification,
  inspectInjectedWalletChain,
  signInWithEvmWallet,
  switchInjectedWalletChain,
} from "@/lib/auth/evm-wallet-sign-in";
import { shortWalletAddress } from "@/lib/auth/wallet-address";
import type { WalletConnectConfiguration } from "@/lib/auth/wallet-connect";
import { isSignInFailure, SignInFailure } from "@/lib/auth/wallet-errors";
import { CONSOLE_HREF } from "@/lib/public/site";
import {
  EMPTY_INJECTED_WALLETS,
  injectedWalletsSnapshot,
  subscribeToInjectedWallets,
  type WalletDiscovery,
} from "@/lib/auth/wallet-providers";

type AuthConfigResponse = {
  enabled: boolean;
  allowedChainIds: number[];
  reason: string | null;
};

export type LoginFormProps = {
  /**
   * Resolved on the server, so the page's own HTML names the variable to set
   * when mobile pairing has no project id.
   */
  mobilePairing: WalletConnectConfiguration;
  /**
   * Why a pairing may not start at all on this host, or null when it may. Decided
   * on the server, so a page served on the wrong host says so in its own HTML.
   */
  pairingBlocked: string | null;
  /** The deployment's validated origin; empty when sign-in is not configured at all. */
  origin: string;
  /** The chains `AUTH_EVM_CHAIN_IDS` accepts, as the server reads them. */
  allowedChainIds: number[];
};

/** What the page is doing right now; one of these is always true. */
type Phase = "idle" | "connecting" | "signing" | "switching" | "signed-in";

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json().catch(() => null);
  if (!value || typeof value !== "object") return {};
  return value as Record<string, unknown>;
}

/**
 * The wallets this page found, and the ones it did not.
 *
 * Discovery runs on mount and again whenever the browser might have changed
 * (visibility, `ethereum#initialized`, a wallet being enabled), because an
 * extension can inject well after the first render. A wallet that is absent is
 * listed with a link to install it rather than as a button that does nothing.
 */
export default function LoginForm({ mobilePairing, pairingBlocked, origin, allowedChainIds }: LoginFormProps) {
  const router = useRouter();
  const [configuration, setConfiguration] = useState<AuthConfigResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [phase, setPhase] = useState<Phase>("idle");
  const [failure, setFailure] = useState<SignInFailure | null>(null);
  const [chainMismatch, setChainMismatch] = useState<{ chainId: number; acceptedChainIds: number[]; walletKind: string } | null>(null);
  // Who signed in, so the page can show the wallet's address whichever way the
  // wallet was reached — injected extension or paired phone.
  const [signedIn, setSignedIn] = useState<{ address: string; role: string } | null>(null);
  // A signed message the server has not spent yet, waiting for a code. Non-null
  // only when the server itself said the account demands one for sign-in.
  const [pendingCode, setPendingCode] = useState<{ message: string; signature: string; address?: string } | null>(null);
  const [code, setCode] = useState("");

  // The injected wallets are an external store: read from the page, and watched
  // for the two events that change them (a wallet injecting after load, or the
  // tab being returned to). `getServerSnapshot` is the empty list, so the server
  // and the first client render agree on "nothing looked at yet".
  const discovery: WalletDiscovery = useSyncExternalStore(
    subscribeToInjectedWallets,
    () => injectedWalletsSnapshot(typeof window === "undefined" ? null : window),
    () => EMPTY_INJECTED_WALLETS,
  );

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
        if (active) setFailure(new SignInFailure("NOT_CONFIGURED", "Authentication status is unavailable.", false));
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, []);

  /**
   * One place decides what signing in looks like, for both wallet kinds — and
   * where it lands. A brand-new account goes to the onboarding checklist, because
   * the four steps are the shortest honest answer to "now what?"; an account that
   * has signed in before goes straight to the console overview.
   *
   * The destination is `CONSOLE_HREF`, not `/`: since the public pages landed, `/`
   * is the signed-out landing page, and sending a signed-in person there hides the
   * console they just authenticated for.
   */
  function completeSignIn(result: { address: string; role: string; newAccount?: boolean }) {
    setSignedIn(result);
    setPhase("signed-in");
    router.replace(result.newAccount ? "/onboarding" : CONSOLE_HREF);
    router.refresh();
  }

  /** A failure is never fatal: the page keeps the wallet and offers the retry. */
  function report(cause: unknown) {
    if (isSignInFailure(cause)) {
      // The one failure that is answered on this page rather than at the wallet:
      // the signature is already judged, only the code is missing.
      if (cause.code === "TOTP_REQUIRED" && cause.pending) setPendingCode(cause.pending);
      setFailure(cause);
      return;
    }
    setFailure(new SignInFailure("PROVIDER_UNAVAILABLE", cause instanceof Error ? cause.message : "Wallet sign-in failed."));
  }

  /**
   * Hand the same signed message back with the code.
   *
   * No wallet prompt happens here: the message and signature were already
   * produced and the server has not consumed them, so this is one POST and, on
   * success, the session the first attempt was about to create.
   */
  async function submitCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!pendingCode) return;
    setPhase("signing");
    setFailure(null);
    try {
      const result = await completeSignInVerification({ ...pendingCode, code });
      const address = result.address ?? pendingCode.address ?? "";
      setPendingCode(null);
      setCode("");
      completeSignIn({ address, role: result.role, newAccount: result.newAccount });
    } catch (cause) {
      report(cause);
    } finally {
      setPhase((current) => (current === "signed-in" ? current : "idle"));
    }
  }

  function acceptedChainIds(): number[] {
    return configuration?.allowedChainIds ?? [];
  }

  async function attempt(wallet: WalletDiscovery["detected"][number]) {
    setFailure(null);
    setChainMismatch(null);
    if (!configuration?.enabled) {
      setFailure(new SignInFailure("NOT_CONFIGURED", configuration?.reason ?? "Wallet sign-in is not enabled.", false));
      return;
    }

    setPhase("connecting");
    try {
      // Read the chain first: if this deployment would refuse the network, the
      // user is told before the wallet asks them for anything.
      const inspection = await inspectInjectedWalletChain({
        scope: window,
        walletKind: wallet.kind,
        walletName: wallet.name,
        allowedChainIds: acceptedChainIds(),
      });
      if (!inspection.accepted) {
        setChainMismatch({
          chainId: inspection.chainId,
          acceptedChainIds: [...inspection.acceptedChainIds],
          walletKind: wallet.kind,
        });
        setFailure(
          new SignInFailure(
            "UNSUPPORTED_CHAIN",
            `Your wallet is connected to ${inspection.chainLabel} (chain ${inspection.chainId}). ${inspection.acceptedChains}`,
          ),
        );
        return;
      }

      setPhase("signing");
      const result = await signInWithEvmWallet({
        scope: window,
        walletKind: wallet.kind,
        walletName: wallet.name,
        allowedChainIds: acceptedChainIds(),
      });
      completeSignIn({ address: result.address, role: result.role, newAccount: result.newAccount });
    } catch (cause) {
      report(cause);
    } finally {
      // Every exit — a refusal, a wrong network, a rejected signature, a
      // success — gives the buttons back. A path that returned while the form
      // was still "busy" would leave the switch offer on screen and unpressable.
      setPhase((current) => (current === "signed-in" ? current : "idle"));
    }
  }

  async function switchNetwork(wallet: WalletDiscovery["detected"][number], chainId: number) {
    setFailure(null);
    setPhase("switching");
    try {
      await switchInjectedWalletChain({ scope: window, walletKind: wallet.kind, walletName: wallet.name, chainId });
      setChainMismatch(null);
      setPhase("idle");
      // The switch is confirmed, so carry straight on into the sign-in the user
      // already asked for instead of making them press the button a second time.
      await attempt(wallet);
    } catch (cause) {
      setPhase("idle");
      report(cause);
    }
  }

  const busy = phase === "connecting" || phase === "signing" || phase === "switching";
  const nothingInstalled = !loading && discovery.detected.length === 0;
  // The offer names the wallet it was raised for; after a re-discovery that
  // wallet is looked up again rather than assumed to still be first.
  const mismatchWallet = discovery.detected.find((wallet) => wallet.kind === chainMismatch?.walletKind);

  return (
    <div className="login-form">
      <div className="login-identity-state">
        <span className={`state-dot ${configuration?.enabled ? "state-dot--amber" : "state-dot--muted"}`} aria-hidden="true" />
        <span>
          {loading
            ? "CHECKING AUTH STATUS"
            : configuration?.enabled
              ? discovery.detected.length > 0
                ? `${discovery.detected.length} INJECTED WALLET${discovery.detected.length === 1 ? "" : "S"} DETECTED`
                : "NO EVM WALLET DETECTED"
              : "EVM SIGN-IN NOT CONFIGURED"}
        </span>
      </div>

      {!loading && configuration?.enabled && (
        <ul className="wallet-list">
          {discovery.detected.map((wallet) => (
            <li className="wallet-row" key={`${wallet.kind}-${wallet.name}`}>
              <div className="wallet-row__identity">
                <Wallet aria-hidden="true" size={16} strokeWidth={1.8} />
                <span>{wallet.name}</span>
                <span className="wallet-row__flags">{wallet.flags.length > 0 ? "detected" : "EIP-1193"}</span>
              </div>
              <button
                className="login-button login-button--compact"
                type="button"
                disabled={busy}
                onClick={() => void attempt(wallet)}
              >
                {busy ? <LoaderCircle className="login-spinner" aria-hidden="true" size={15} /> : <Wallet aria-hidden="true" size={15} />}
                <span>{phase === "switching" ? "SWITCHING NETWORK" : `SIGN IN WITH ${wallet.name.toUpperCase()}`}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {nothingInstalled && (
        <div className="login-unavailable" role="status">
          <AlertTriangle aria-hidden="true" size={15} />
          <span>
            No EVM wallet extension is installed in this browser, so there is nothing to sign in with yet. Install one of
            the wallets below, then reload this page — sign-in will find it automatically.
          </span>
        </div>
      )}

      {!loading && discovery.missing.length > 0 && (
        <ul className="wallet-missing" aria-label="Wallets that were not detected">
          {discovery.missing.map((wallet) => (
            <li key={wallet.kind}>
              <span>{wallet.name} was not detected.</span>
              <a className="wallet-missing__install" href={wallet.installUrl} target="_blank" rel="noreferrer noopener">
                <Download aria-hidden="true" size={13} />
                <span>Install {wallet.name}</span>
              </a>
            </li>
          ))}
        </ul>
      )}

      {chainMismatch && (
        <div className="login-switch-offer" role="status">
          <AlertTriangle aria-hidden="true" size={15} />
          <span>
            This wallet is on {evmChainLabel(chainMismatch.chainId)} (chain {chainMismatch.chainId}).{" "}
            {describeAcceptedChains(chainMismatch.acceptedChainIds)} Accepting this offer asks the wallet to switch;
            nothing is signed until the wallet is on an accepted network.
          </span>
          <div className="login-switch-offer__actions">
            {chainMismatch.acceptedChainIds.map((chainId) => (
              <button
                className="login-button login-button--compact"
                type="button"
                key={chainId}
                disabled={busy || !mismatchWallet}
                onClick={() => mismatchWallet && void switchNetwork(mismatchWallet, chainId)}
              >
                <RefreshCw aria-hidden="true" size={15} />
                <span>SWITCH TO {evmChainLabel(chainId).toUpperCase()}</span>
              </button>
            ))}
          </div>
          <span className="login-switch-offer__note">
            If the switch is declined, move the wallet to an accepted network yourself and sign in again — nothing on this
            page needs reloading.
          </span>
        </div>
      )}

      {failure && (
        <p className={`login-error login-error--${failure.code.toLowerCase()}`} role="alert">
          {failure.retryable && <AlertTriangle aria-hidden="true" size={14} />}
          <span>{failure.message}</span>
          <span className="login-error__code">{failure.code}</span>
        </p>
      )}

      {pendingCode && (
        <form className="login-totp" onSubmit={submitCode}>
          <label className="login-totp__field" htmlFor="login-totp-code">
            <span>AUTHENTICATOR CODE</span>
            <input
              id="login-totp-code"
              autoComplete="one-time-code"
              maxLength={16}
              value={code}
              onChange={(event) => setCode(event.target.value)}
            />
          </label>
          <button className="login-button login-button--compact" disabled={busy || code.length < 6} type="submit">
            {busy ? <LoaderCircle aria-hidden="true" className="login-spinner" size={15} /> : <LockKeyhole aria-hidden="true" size={15} />}
            <span>{busy ? "CHECKING CODE" : "VERIFY AND SIGN IN"}</span>
          </button>
          <small className="login-totp__note">
            The signature you already provided is still valid — this only adds the code, so your wallet is not asked to sign
            again. A backup code works here too, and it works while the account is locked.
          </small>
        </form>
      )}

      {phase === "signed-in" && (
        <p className="login-signed-in" role="status">
          <CheckCircle2 aria-hidden="true" size={15} />
          <span>
            Signed in{signedIn ? ` as ${shortWalletAddress(signedIn.address)}` : ""}. Loading the console…
          </span>
        </p>
      )}

      {!loading && !configuration?.enabled && (
        <div className="login-unavailable" role="status">
          <LockKeyhole aria-hidden="true" size={15} />
          <span>{configuration?.reason ?? "Authentication is not configured."}</span>
        </div>
      )}

      {configuration?.enabled && origin !== "" && (
        <WalletConnectPairing
          configuration={mobilePairing}
          blocked={pairingBlocked}
          origin={origin}
          allowedChainIds={allowedChainIds}
          onSignedIn={completeSignIn}
        />
      )}

      {failure && failure.retryable && (
        <p className="login-retry-hint">
          Nothing was signed in, so there is nothing to undo. Press a wallet button above to try again.
        </p>
      )}
    </div>
  );
}
