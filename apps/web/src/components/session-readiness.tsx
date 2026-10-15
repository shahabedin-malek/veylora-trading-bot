import { LogIn, Wallet } from "lucide-react";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { getCurrentUser } from "@/lib/auth/session-store";

function shortAddress(address: string | null) {
  return address ? `${address.slice(0, 6)}...${address.slice(-4)}` : "Wallet connected";
}

function TradingState() {
  return (
    <div className="trading-readiness" role="status">
      <div className="session-state">
        <span className="state-dot state-dot--amber" aria-hidden="true" />
        <span>NO ORDER ROUTE</span>
      </div>
      <p>Order placement is not wired yet, so no order can be submitted.</p>
    </div>
  );
}

async function CurrentTradingState() {
  await connection();
  return <TradingState />;
}

export function TradingReadiness() {
  return (
    <Suspense fallback={<TradingState />}>
      <CurrentTradingState />
    </Suspense>
  );
}

async function CurrentSessionAction() {
  await connection();
  const user = await getCurrentUser();
  if (!user) {
    return (
      <Link className="topbar-login" href="/login" aria-label="Sign in with an EVM wallet">
        <LogIn aria-hidden="true" size={14} strokeWidth={1.8} />
        <span>SIGN IN</span>
      </Link>
    );
  }

  return (
    <span className="topbar-wallet-state" aria-label={`Connected wallet ${shortAddress(user.address)}`}>
      <Wallet aria-hidden="true" size={14} strokeWidth={1.8} />
      <span>{shortAddress(user.address)}</span>
    </span>
  );
}

export function SessionTopbarAction() {
  return (
    <Suspense fallback={<span className="topbar-disconnected">CHECKING SESSION</span>}>
      <CurrentSessionAction />
    </Suspense>
  );
}