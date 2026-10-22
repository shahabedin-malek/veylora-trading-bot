"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { LoaderCircle, LogOut, Wallet } from "lucide-react";
import { shortWalletAddress } from "@/lib/auth/wallet-address";

/**
 * The signed-in wallet, and the way out of it.
 *
 * Signing in had no counterpart: the session cookie was set, the top bar showed
 * the address, and nothing in the interface could end the session. Sign-out now
 * calls `DELETE /api/auth/session`, which rotates the account's
 * `sessionVersion` **and** clears the cookie, so the session ends on the server
 * rather than only in the browser — a cookie captured before sign-out is
 * worthless afterwards, which is what `sessionMatchesUser` enforces on every
 * page and route.
 *
 * The address shown is the checksummed form from the shared normaliser
 * (`wallet-address.ts`), never a raw value from the wallet or the cookie.
 */
export function SessionActions({ address, role }: { address: string | null; role: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = address ? shortWalletAddress(address) : "Wallet connected";

  async function signOut() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/session", { method: "DELETE", credentials: "same-origin" });
      if (!response.ok) throw new Error(`Sign-out was refused by the server (HTTP ${response.status}).`);
      router.replace("/login");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Sign-out could not be completed.");
      setBusy(false);
    }
  }

  return (
    <span className="topbar-session">
      <span className="topbar-wallet-state" aria-label={`Signed in as ${role.toLowerCase()} with wallet ${label}`}>
        <Wallet aria-hidden="true" size={14} strokeWidth={1.8} />
        <span>{label}</span>
      </span>
      <button className="topbar-signout" type="button" disabled={busy} onClick={() => void signOut()}>
        {busy ? <LoaderCircle className="login-spinner" aria-hidden="true" size={13} /> : <LogOut aria-hidden="true" size={13} />}
        <span>SIGN OUT</span>
      </button>
      {error && <span className="topbar-signout-error" role="alert">{error}</span>}
    </span>
  );
}
