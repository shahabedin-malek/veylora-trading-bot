"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Copy, LoaderCircle, RefreshCw, Smartphone } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { inspectInjectedWalletChain, signInWithEvmWallet } from "@/lib/auth/evm-wallet-sign-in";
import { shortWalletAddress } from "@/lib/auth/wallet-address";
import { isSignInFailure } from "@/lib/auth/wallet-errors";
import {
  advancePairingStage,
  classifyPairingFailure,
  isPairingFailure,
  PAIRING_STAGE_COPY,
  pairedChainFailure,
  PairingFailure,
  pairingExpiredFailure,
  pairingIsBusy,
  pairingLinks,
  pairingShowsUri,
  type PairingEvent,
  type PairingLinks,
  type PairingStage,
  type WalletConnectConfiguration,
} from "@/lib/auth/wallet-connect";
import { resolvePairingFactory, type PairingPort, type PairingResume } from "@/lib/auth/wallet-connect-client";

/**
 * The mobile pairing surface.
 *
 * Three things reach the same pairing — the QR a desktop scans, the deep link a
 * phone opens, and the link that gets copied into a wallet — and the panel says
 * which of the pairing's stages it is in at all times, because a QR on screen
 * that nothing answers is indistinguishable from a broken page. Failures are
 * shown in place with a retry, including the pairing that lapsed while the user
 * was finding their phone.
 *
 * Once a phone is paired the sign-in is phase 07's, unchanged: the same nonce
 * route, the same SIWE verification, the same session. The only thing pairing
 * changes is which provider signs.
 */

/** Only ever a flag: whether a pairing was in flight when this tab last rendered. */
const IN_FLIGHT_KEY = "veylora.pairing.inflight";

type ShownFailure = { code: string; message: string; retryable: boolean };

function toShownFailure(error: unknown): ShownFailure {
  // A failure from the SIWE flow keeps its own wording and code: "the signature
  // was rejected" is a different thing from "the pairing failed", and the user
  // has to do something different about each.
  if (isPairingFailure(error)) return { code: error.code, message: error.message, retryable: error.retryable };
  if (isSignInFailure(error)) return { code: error.code, message: error.message, retryable: error.retryable };
  const classified = classifyPairingFailure(error);
  return { code: classified.code, message: classified.message, retryable: classified.retryable };
}

function countdown(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

export type WalletConnectPairingProps = {
  configuration: WalletConnectConfiguration;
  /** Why pairing may not start on this host, or null when it may. */
  blocked: string | null;
  /** The deployment's validated origin, never `location.origin`. */
  origin: string;
  allowedChainIds: readonly number[];
  onSignedIn: (result: { address: string; role: string }) => void;
};

export default function WalletConnectPairing(props: WalletConnectPairingProps) {
  const { configuration, blocked, origin, allowedChainIds, onSignedIn } = props;
  const projectId = configuration.configured ? configuration.projectId : null;

  const [stage, setStage] = useState<PairingStage>("idle");
  const [ready, setReady] = useState(false);
  const [links, setLinks] = useState<PairingLinks | null>(null);
  const [failure, setFailure] = useState<ShownFailure | null>(null);
  const [resume, setResume] = useState<PairingResume | null>(null);
  const [walletName, setWalletName] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "blocked">("idle");
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);

  const portRef = useRef<PairingPort | null>(null);
  const stageRef = useRef<PairingStage>("idle");
  const allowedRef = useRef<readonly number[]>(allowedChainIds);
  const signedInRef = useRef(onSignedIn);

  useEffect(() => {
    allowedRef.current = allowedChainIds;
  }, [allowedChainIds]);
  useEffect(() => {
    signedInRef.current = onSignedIn;
  }, [onSignedIn]);
  useEffect(() => {
    stageRef.current = stage;
  }, [stage]);

  /** Every stage change goes through the transition table, so no path can stall. */
  const advance = useCallback((event: PairingEvent) => {
    setStage((current) => advancePairingStage(current, event));
  }, []);

  /**
   * Pairing is over; sign in with the paired wallet through phase 07's flow.
   *
   * The chain is checked first, exactly as it is for an injected wallet, so a
   * phone that paired on a chain this deployment does not accept is told that
   * before anything is asked of the wallet.
   */
  const signInPairedWallet = useCallback(
    async (port: PairingPort) => {
      const scope = typeof window === "undefined" ? null : window;
      try {
        const provider = port.provider();
        const name = port.walletName() ?? "The paired wallet";
        setWalletName(port.walletName() ?? null);
        if (!provider) {
          throw new PairingFailure(
            "PAIRING_FAILED",
            `${name} is not connected in this browser any more, so sign-in cannot continue. Start pairing again.`,
          );
        }

        const inspection = await inspectInjectedWalletChain({
          scope,
          walletKind: "walletconnect",
          walletName: name,
          provider,
          allowedChainIds: allowedRef.current,
        });
        if (!inspection.accepted) {
          throw pairedChainFailure({ chainId: inspection.chainId, acceptedChainIds: [...inspection.acceptedChainIds] });
        }

        advance({ type: "SIGN_REQUESTED" });
        const result = await signInWithEvmWallet({
          scope,
          walletKind: "walletconnect",
          walletName: name,
          provider,
          allowedChainIds: allowedRef.current,
        });
        window.sessionStorage.removeItem(IN_FLIGHT_KEY);
        advance({ type: "SIGNED" });
        signedInRef.current({ address: result.address, role: result.role });
      } catch (error) {
        window.sessionStorage.removeItem(IN_FLIGHT_KEY);
        setFailure(toShownFailure(error));
        advance({ type: "FAILED" });
      }
    },
    [advance],
  );

  useEffect(() => {
    if (projectId === null) return;
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;

    void (async () => {
      try {
        const port = await resolvePairingFactory()({ projectId, origin, chainIds: [...allowedRef.current] });
        if (cancelled) {
          port.stop();
          return;
        }
        portRef.current = port;
        setWalletName(port.walletName() ?? null);
        setReady(true);

        unsubscribe = port.subscribe((event) => {
          if (cancelled) return;
          switch (event.type) {
            case "uri":
              setLinks(pairingLinks(event.uri));
              advance({ type: "URI_READY" });
              return;
            case "paired":
              setWalletName(port.walletName() ?? null);
              advance({ type: "PAIRED" });
              void signInPairedWallet(port);
              return;
            case "chain":
              // Ignored on purpose: the sign-in flow reads the chain from the
              // provider itself, and a cached event must not decide it.
              return;
            case "disconnected":
              if (!pairingIsBusy(stageRef.current)) return;
              window.sessionStorage.removeItem(IN_FLIGHT_KEY);
              setFailure({
                code: "PAIRING_FAILED",
                message:
                  "The wallet disconnected before sign-in finished, so nothing was signed. Start pairing again to reconnect it.",
                retryable: true,
              });
              advance({ type: "FAILED" });
              return;
            case "failed":
              window.sessionStorage.removeItem(IN_FLIGHT_KEY);
              setFailure(toShownFailure(event.error));
              advance({ type: "FAILED" });
              return;
          }
        });

        // A session that survived a reload. A pairing that was in flight when the
        // page went away continues on its own, because the phone already approved
        // it; one left over from an earlier visit waits for a press, so signing
        // out is not quietly undone by opening this page again.
        const restored = await port.resume();
        if (cancelled || !restored) return;
        setWalletName(port.walletName() ?? null);
        setResume(restored);
        advance({ type: "PAIRED" });
        if (window.sessionStorage.getItem(IN_FLIGHT_KEY) === "1") void signInPairedWallet(port);
      } catch (error) {
        if (cancelled) return;
        setFailure(toShownFailure(error));
        advance({ type: "FAILED" });
      }
    })();

    return () => {
      cancelled = true;
      unsubscribe?.();
      portRef.current?.stop();
      portRef.current = null;
      setReady(false);
    };
  }, [projectId, origin, advance, signInPairedWallet]);

  // The pairing's own expiry, when the URI states one. Nothing is invented if it
  // does not: the code simply stays on screen until the wallet or the relay says
  // otherwise. The first value is seeded where the links are set, so this effect
  // only ever writes from its interval.
  useEffect(() => {
    const endsAt = links?.expiresAt?.getTime() ?? null;
    if (endsAt === null || !pairingShowsUri(stage)) return;
    const timer = window.setInterval(() => {
      const left = Math.max(0, Math.round((endsAt - Date.now()) / 1000));
      setSecondsLeft(left);
      if (left === 0) {
        window.sessionStorage.removeItem(IN_FLIGHT_KEY);
        setFailure(toShownFailure(pairingExpiredFailure()));
        advance({ type: "FAILED" });
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [links, stage, advance]);

  const start = useCallback(async () => {
    const port = portRef.current;
    setFailure(null);
    setResume(null);
    setLinks(null);
    setCopyState("idle");
    setSecondsLeft(null);
    if (!port) {
      setFailure({
        code: "PAIRING_FAILED",
        message: "Pairing is still starting up. Press the button again in a moment.",
        retryable: true,
      });
      return;
    }
    advance({ type: "START" });
    window.sessionStorage.setItem(IN_FLIGHT_KEY, "1");
    try {
      const produced = await port.start();
      setLinks(produced);
      setSecondsLeft(produced.expiresAt ? Math.max(0, Math.round((produced.expiresAt.getTime() - Date.now()) / 1000)) : null);
      advance({ type: "URI_READY" });
    } catch (error) {
      window.sessionStorage.removeItem(IN_FLIGHT_KEY);
      setFailure(toShownFailure(error));
      advance({ type: "FAILED" });
    }
  }, [advance]);

  const cancel = useCallback(async () => {
    window.sessionStorage.removeItem(IN_FLIGHT_KEY);
    setLinks(null);
    setFailure(null);
    setResume(null);
    setCopyState("idle");
    setSecondsLeft(null);
    advance({ type: "RESET" });
    try {
      await portRef.current?.disconnect();
    } catch {
      // A teardown that fails must not leave the surface stuck: the session is
      // gone from this page either way, and pairing again starts a fresh one.
    }
  }, [advance]);

  const copyLink = useCallback(async () => {
    const value = links?.copyValue;
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopyState("copied");
    } catch {
      // No clipboard permission (or no clipboard at all): the link is put in a
      // field that can be selected by hand rather than reported as copied.
      setCopyState("blocked");
    }
  }, [links]);

  if (blocked !== null) {
    return (
      <div className="pairing-unconfigured" role="status">
        <AlertTriangle aria-hidden="true" size={15} />
        <span>{blocked}</span>
      </div>
    );
  }

  if (!configuration.configured) {
    return (
      <div className="pairing-unconfigured" role="status">
        <AlertTriangle aria-hidden="true" size={15} />
        <span>{configuration.reason}</span>
      </div>
    );
  }

  const stageCopy = PAIRING_STAGE_COPY[stage];

  return (
    <section className="pairing" aria-label="Mobile wallet pairing">
      <div className="pairing__heading">
        <span>MOBILE WALLET / WALLETCONNECT</span>
        <span className="pairing__state">{stageCopy.label}</span>
      </div>
      <p className="pairing__stage">{stageCopy.detail}</p>

      {stage === "idle" && (
        <button className="login-button" type="button" disabled={!ready} onClick={() => void start()}>
          {ready ? <Smartphone aria-hidden="true" size={15} /> : <LoaderCircle className="login-spinner" aria-hidden="true" size={15} />}
          <span>{ready ? "START PAIRING" : "PREPARING PAIRING"}</span>
        </button>
      )}

      {(stage === "preparing" || (stage === "waiting" && !links)) && (
        <p className="pairing__waiting" role="status">
          <LoaderCircle className="login-spinner" aria-hidden="true" size={15} />
          <span>Asking the relay for a pairing code…</span>
        </p>
      )}

      {pairingShowsUri(stage) && links && (
        <div className="pairing__uri">
          <div className="pairing-qr">
            <QRCodeSVG value={links.qrValue} size={164} level="M" marginSize={2} bgColor="#e5eeeb" fgColor="#0b1011" />
          </div>
          <div className="pairing__ways">
            <span className="pairing__ways-title">THREE WAYS TO THE SAME PAIRING</span>
            <span className="pairing__way">Scan the code with the wallet on your phone.</span>
            <a className="login-button login-button--compact login-button--secondary" href={links.deepLink}>
              <Smartphone aria-hidden="true" size={15} />
              <span>OPEN ON THIS PHONE</span>
            </a>
            <button className="login-button login-button--compact login-button--secondary" type="button" onClick={() => void copyLink()}>
              {copyState === "copied" ? <Check aria-hidden="true" size={15} /> : <Copy aria-hidden="true" size={15} />}
              <span>{copyState === "copied" ? "LINK COPIED" : "COPY LINK"}</span>
            </button>
            {copyState === "blocked" && (
              <input
                className="pairing__manual"
                readOnly
                aria-label="Pairing link to copy by hand"
                value={links.copyValue}
                onFocus={(event) => event.currentTarget.select()}
              />
            )}
            {secondsLeft !== null && (
              <span className="pairing__expiry">
                This code expires in {countdown(secondsLeft)}. A fresh one is one press away.
              </span>
            )}
            <button className="login-button login-button--compact login-button--secondary" type="button" onClick={() => void cancel()}>
              CANCEL PAIRING
            </button>
          </div>
        </div>
      )}

      {stage === "paired" && resume && (
        <div className="pairing__resume">
          <span>
            {walletName ?? "A paired wallet"} is still connected
            {resume.accounts[0] ? ` as ${shortWalletAddress(resume.accounts[0])}` : ""}
            {resume.chainId !== null ? ` on chain ${resume.chainId}` : ""}. Its connection survived a reload, so there is
            nothing to scan again — but signing in is a press away rather than automatic, so signing out stays signed
            out.
          </span>
          <div className="pairing__resume-actions">
            <button className="login-button login-button--compact" type="button" onClick={() => portRef.current && void signInPairedWallet(portRef.current)}>
              <RefreshCw aria-hidden="true" size={15} />
              <span>CONTINUE SIGN-IN</span>
            </button>
            <button className="login-button login-button--compact login-button--secondary" type="button" onClick={() => void cancel()}>
              FORGET THIS PAIRING
            </button>
          </div>
        </div>
      )}

      {failure && (
        <p className="login-error" role="alert">
          {failure.retryable && <AlertTriangle aria-hidden="true" size={14} />}
          <span>{failure.message}</span>
          <span className="login-error__code">{failure.code}</span>
        </p>
      )}

      {stage === "failed" && (
        <button className="login-button" type="button" onClick={() => void start()}>
          <RefreshCw aria-hidden="true" size={15} />
          <span>START PAIRING AGAIN</span>
        </button>
      )}
    </section>
  );
}
