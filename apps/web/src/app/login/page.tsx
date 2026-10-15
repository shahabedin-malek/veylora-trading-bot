import LoginForm from "@/app/login/login-form";
import { DepthText } from "@/components/depth-text";
import { GlareHover } from "@/components/glare-hover";
import Link from "next/link";
import { connection } from "next/server";
import { describeAcceptedChains } from "@/lib/auth/chain-labels";
import { getAuthConfig } from "@/lib/auth/config";

const walletConnectConfigured = Boolean(
  process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID?.trim() || process.env.NEXT_PUBLIC_REOWN_PROJECT_ID?.trim(),
);

// The accepted-chain sentence below reads `AUTH_EVM_CHAIN_IDS` at render time, so
// this route renders on demand instead of prerendering (Next's "blocking route"
// opt-out for Cache Components).
export const instant = false;

export const metadata = {
  title: "Sign in | Veylora",
  description: "Sign in with an EVM wallet.",
};

export default async function LoginPage() {
  // Rendered per request: the accepted-chain sentence must reflect the deployment's
  // current AUTH_EVM_CHAIN_IDS, not whatever env existed at build time.
  await connection();
  const config = getAuthConfig();
  const acceptedChains = describeAcceptedChains(config ? [...config.allowedChainIds] : []);

  return (
    <main className="login-page">
      <Link className="login-back" href="/">← Back to overview</Link>
      <GlareHover className="login-panel-glare">
      <section className="login-panel" aria-labelledby="login-title">
        <div className="section-kicker">IDENTITY / EVM</div>
        <h1 id="login-title"><DepthText text="Sign in" /></h1>
        <p className="login-intro">Authenticate wallet ownership. This signature does not authorize a transaction.</p>
        <p className="login-accepted-chains">{acceptedChains}</p>
        <LoginForm />
        <section className="login-provider-status" aria-label="Reown WalletConnect status">
          <div className="login-provider-status__heading">
            <span>RAINBOWKIT / WALLETCONNECT</span>
            <span className="section-state">{walletConnectConfigured ? "READY" : "PROJECT ID REQUIRED"}</span>
          </div>
          <p>{walletConnectConfigured
            ? "Injected EVM wallets and WalletConnect-compatible mobile wallets are available."
            : "Injected EVM wallets remain available. WalletConnect mobile pairing requires a WalletConnect project ID. Solana and other non-EVM wallet sign-in are not enabled."}</p>
        </section>
        <p className="login-safety">No seed phrase or private key is requested.</p>
      </section>
      </GlareHover>
    </main>
  );
}
