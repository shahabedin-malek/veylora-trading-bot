import type { Metadata } from "next";
import Link from "next/link";
import {
  LEGAL_REVIEWED_ON,
  NOT_STATEMENTS,
  OPERATOR_CONTACT,
  OPERATOR_NAME,
} from "@/lib/public/site";

/**
 * Terms of use.
 *
 * Written against what the code actually does: the wallet is the credential, the ledger is the
 * record of balances, withdrawals go to an address the user supplies and cannot be recalled, and
 * fees are the table on `/pricing`. Nothing here is copied from another venue's terms, and the one
 * thing this page cannot honestly state — a governing jurisdiction — is named as outstanding
 * rather than filled with a plausible-sounding place.
 */

export const metadata: Metadata = {
  title: "Terms of use",
  description: `The terms under which ${OPERATOR_NAME} provides this trading console.`,
};

export default function TermsPage() {
  return (
    <article className="public-prose">
      <p className="eyebrow">LEGAL <span className="eyebrow-separator">/</span> TERMS OF USE</p>
      <h1>Terms of use</h1>
      <p className="public-meta">
        <span>{OPERATOR_NAME}</span>
        <span>Reviewed {LEGAL_REVIEWED_ON}</span>
        <span>Applies to this deployment</span>
      </p>

      <p>
        These terms are between you and {OPERATOR_NAME}, the operator of this deployment (the
        &ldquo;service&rdquo;). By signing in, depositing or placing an order you accept them. If you do
        not, do not use the service.
      </p>

      <h2>1. What the service is — and what it is not</h2>
      <p>
        The service is a trading console for crypto markets. You sign in with a wallet signature,
        your balance is recorded in this deployment&apos;s own ledger, and orders are sent to the
        venue whose key you connect.
      </p>
      <ul>
        {NOT_STATEMENTS.map((statement) => (
          <li key={statement}>{statement}</li>
        ))}
      </ul>
      <p>
        Nothing in the console, the assistant, a strategy description or a backtest is a
        recommendation to buy or sell anything. A strategy you start is yours: it acts on the rules
        you chose, with the size you set, under the limits the operator configured.
      </p>

      <h2>2. Who may use it</h2>
      <p>
        You must be old enough to enter a contract where you live and must not be barred from using
        a service like this there. You are responsible for whether using it is lawful in your
        jurisdiction, and for any tax that follows from your trading.
      </p>

      <h2>3. Your account and your keys</h2>
      <ul>
        <li>
          <strong>Your wallet is the credential.</strong> There is no password to reset. If you lose
          access to the wallet, the operator cannot restore it for you.
        </li>
        <li>
          <strong>Venue keys are yours.</strong> A key you connect is stored encrypted and used only
          for the actions you take through the console. Revoke it here or at the venue at any time;
          revocation here takes effect on the next request.
        </li>
        <li>
          <strong>You are responsible for your device.</strong> Two-factor scopes, session revocation
          and API keys exist so you can limit the damage of a compromised device, and using them is
          your decision.
        </li>
      </ul>

      <h2>4. Balances, deposits and withdrawals</h2>
      <ul>
        <li>
          A balance is the sum of ledger entries. It is not a bank deposit, it is not insured, and it
          is not held in a segregated account at a bank or a broker.
        </li>
        <li>
          A deposit is credited when the network reaches the confirmation count the operator
          configured for that network. Before then it is recorded as pending, with the reason.
        </li>
        <li>
          A withdrawal is sent to the address you supply, after the platform fee is deducted. On-chain
          transfers are irreversible: if you supply a wrong address, the operator cannot recall the
          transfer. A new destination may be held for the window the operator configured.
        </li>
        <li>
          Fees are the table published on <Link href="/pricing">the pricing page</Link>, read from the
          same version the withdrawal path charges. There is no subscription and no deposit fee.
        </li>
      </ul>

      <h2>5. Orders and execution</h2>
      <ul>
        <li>
          The console states its mode on the landing page and in the trading view: paper orders,
          testnet orders or live orders at a named venue. Paper results never place a real order.
        </li>
        <li>
          Live execution is reachable only while the operator&apos;s live switch is on, and that switch
          is theirs to turn off at any time.
        </li>
        <li>
          An order can fail at the venue. When it does, the order row carries the venue&apos;s reason and
          the attempts made; a failed order is not a filled order.
        </li>
        <li>Orders you place are also subject to the venue&apos;s own terms.</li>
      </ul>

      <h2>6. Acceptable use</h2>
      <p>You agree not to:</p>
      <ul>
        <li>use the service for anything unlawful, including market manipulation or moving the proceeds of crime;</li>
        <li>attempt to bypass authentication, authorisation, rate limits or the operator&apos;s risk controls;</li>
        <li>probe, scan or overload the deployment, or use it to attack a third party;</li>
        <li>share an API key, or use one to act for an account that is not yours.</li>
      </ul>
      <p>
        The operator may suspend an account that does any of these things, and will say why in the
        audit trail. Suspension is not confiscation: balances stay on the ledger and the operator
        will tell you how to withdraw them, subject to any legal restraint that applies.
      </p>

      <h2>7. Availability and changes</h2>
      <p>
        The service is provided as it is. No uptime is promised, no maintenance window is guaranteed,
        and features may change or be withdrawn. The{" "}
        <Link href="/status">status page</Link> reports what the deployment is doing at the moment
        you read it; it is not a service-level agreement.
      </p>
      <p>
        These terms may be updated. The date at the top changes when they do, and a change that
        affects money, fees or your rights will be shown in the application before it takes effect.
      </p>

      <h2>8. Liability</h2>
      <p>
        Trading loses money. The operator is not liable for market losses, for a venue&apos;s failure,
        for a network&apos;s failure, or for a strategy you chose to run. To the extent the law where
        you live allows, the operator&apos;s liability is limited to the fees you paid in the three
        months before the event. Nothing here excludes a liability that cannot lawfully be excluded.
      </p>

      <h2>9. Governing law — not yet named</h2>
      <p>
        These terms do not yet name a governing jurisdiction, because the operator has not registered
        an entity. That is stated rather than filled with a plausible place. Before any commercial
        launch this section will name the jurisdiction and the dispute route, and the change will be
        announced in the application.
      </p>

      <h2>10. Contact</h2>
      <p>
        Questions about these terms, or about an account, go to {OPERATOR_CONTACT}. The{" "}
        <Link href="/privacy">privacy page</Link> explains what is stored, and the{" "}
        <Link href="/risk">risk disclosure</Link> explains what can go wrong.
      </p>
    </article>
  );
}
