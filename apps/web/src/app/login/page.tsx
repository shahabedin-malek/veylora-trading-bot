import LoginForm from "@/app/login/login-form";
import { DepthText } from "@/components/depth-text";
import { GlareHover } from "@/components/glare-hover";
import Link from "next/link";
import { headers } from "next/headers";
import { connection } from "next/server";
import { describeAcceptedChains } from "@/lib/auth/chain-labels";
import { getAuthConfig, pairingHostProblem } from "@/lib/auth/config";
import { resolveWalletConnectProjectId } from "@/lib/auth/wallet-connect";

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

  // The pairing configuration and the origin it is bound to are decided here, on
  // the server, from the same values the routes use — so the page names a missing
  // variable in its own HTML, and the metadata a wallet displays can only ever be
  // this deployment's validated origin rather than a request Host.
  const pairing = resolveWalletConnectProjectId({
    NEXT_PUBLIC_REOWN_PROJECT_ID: process.env.NEXT_PUBLIC_REOWN_PROJECT_ID,
    NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID,
  });
  // A wallet is told which site is asking to connect, so a page served on a host
  // that is not the configured one refuses to pair — in its own HTML, before any
  // script runs — rather than advertising somebody else's site to a phone.
  const pairingOnWrongHost = config
    ? pairingHostProblem({ configuredOrigin: config.origin, requestHost: (await headers()).get("host") })
    : "APP_BASE_URL is not configured, so there is no origin a wallet could be sent back to.";

  return (
    <main className="login-page">
      {/* The public landing page, not `/terminal`: a visitor reading this page has no
          session yet, and the console would bounce them straight back here. */}
      <Link className="login-back" href="/">← Back to the front page</Link>
      <GlareHover className="login-panel-glare">
      <section className="login-panel" aria-labelledby="login-title">
        <div className="section-kicker">IDENTITY / EVM</div>
        <h1 id="login-title"><DepthText text="Sign in" /></h1>
        <p className="login-intro">Authenticate wallet ownership. This signature does not authorize a transaction.</p>
        <p className="login-accepted-chains">{acceptedChains}</p>
        <LoginForm
          mobilePairing={pairing}
          pairingBlocked={pairingOnWrongHost}
          origin={config?.origin ?? ""}
          allowedChainIds={config ? [...config.allowedChainIds] : []}
        />
        <section className="login-provider-status" aria-label="Wallet support status">
          <div className="login-provider-status__heading">
            <span>INJECTED PROVIDERS / WALLETCONNECT</span>
            <span className="section-state">{pairing.configured ? "PAIRING CONFIGURED" : "PROJECT ID REQUIRED"}</span>
          </div>
          <p>{`Sign-in asks the EIP-1193 wallets injected into this browser: MetaMask, Rabby, Coinbase Wallet and any other injected provider are detected as the page loads and listed above with what was found. WalletConnect mobile pairing ${
            pairing.configured
              ? "is configured and shown above: a phone scans the code, opens the deep link or pastes the copied link, and completes the same sign-in."
              : "has no project ID, which the panel above names."
          } Solana and other non-EVM wallet sign-in are not enabled.`}</p>
        </section>
        <p className="login-safety">No seed phrase or private key is requested.</p>
      </section>
      </GlareHover>
    </main>
  );
}
