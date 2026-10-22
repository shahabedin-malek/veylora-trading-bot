import type { Metadata } from "next";
import Link from "next/link";
import {
  LEGAL_REVIEWED_ON,
  OPERATOR_CONTACT,
  OPERATOR_NAME,
} from "@/lib/public/site";

/**
 * Privacy.
 *
 * Every category below is a table or a field that exists in `prisma/schema.prisma` or a value a
 * route writes — not a generic list copied from a template. The two absences are worth stating
 * plainly because they are unusual: there is no email address and no legal name on `User`, and the
 * only cookie is the session. If that changes, this page is wrong and must change with it.
 */

export const metadata: Metadata = {
  title: "Privacy",
  description: `What ${OPERATOR_NAME} stores about an account, why, for how long, and how to get a copy.`,
};

export default function PrivacyPage() {
  return (
    <article className="public-prose">
      <p className="eyebrow">LEGAL <span className="eyebrow-separator">/</span> PRIVACY</p>
      <h1>Privacy</h1>
      <p className="public-meta">
        <span>{OPERATOR_NAME}</span>
        <span>Reviewed {LEGAL_REVIEWED_ON}</span>
        <span>Describes this deployment&apos;s database</span>
      </p>

      <p>
        This page describes what this deployment stores, because that is the part the operator
        controls. It is written from the database schema, so it is a description of the system rather
        than a promise about it.
      </p>

      <h2>What is stored</h2>
      <ul>
        <li>
          <strong>Your wallet address</strong> — the address that signed in, its chain, and how the
          signature was proved (an ordinary account or a contract account). This is the identity the
          account is keyed on.
        </li>
        <li>
          <strong>Sessions</strong> — one row per signed-in device: a device label derived from the
          browser&apos;s user-agent, the IP address the request came from, when it was created, last
          seen and when it expires. Signing out or revoking a device ends the row.
        </li>
        <li>
          <strong>Money and trading records</strong> — ledger entries, deposits and their evidence,
          withdrawals and their destination addresses, orders and their attempts, strategy
          definitions, decisions and backtests.
        </li>
        <li>
          <strong>Security material</strong> — a two-factor secret if you enrol, backup-code hashes,
          and the hashes of any API keys you create. A venue key you connect is encrypted before it is
          stored, and the console can only show its fingerprint.
        </li>
        <li>
          <strong>Audit events</strong> — who did what, when, to which object, and the outcome, with a
          redacted payload. Secrets, keys and session values are removed before an event is written.
        </li>
        <li>
          <strong>Support content</strong> — tickets, messages, notes and the attachments you choose to
          include.
        </li>
      </ul>

      <h2>What is not collected</h2>
      <ul>
        <li>
          <strong>No email address and no legal name</strong>, because the account is a wallet. There is
          no sign-up form to fill in.
        </li>
        <li>
          <strong>No card or bank details</strong> — this deployment takes no card payment and has no
          subscription billing.
        </li>
        <li>
          <strong>No analytics, advertising or fingerprinting scripts.</strong> The pages load no
          third-party script, which is why the content-security policy can refuse one.
        </li>
      </ul>

      <h2>Cookies</h2>
      <p>
        One cookie, <code>veylora_session</code>. It is <code>HttpOnly</code>,{" "}
        <code>SameSite=Strict</code>, <code>Secure</code> on a production origin, scoped to{" "}
        <code>/</code>, and it expires after eight hours. It holds a signed claim naming the account
        and the session row — not a password and not a key. Signing out clears it and revokes the row
        it names, so a copy of the cookie stops working on the next request. There is no consent
        banner because there is nothing to consent to beyond the session the service cannot work
        without.
      </p>

      <h2>Who else sees data</h2>
      <ul>
        <li>
          <strong>RPC and market-data providers</strong> — the deployment reads chain and market data
          from the providers the operator configured; a request carries no account identity.
        </li>
        <li>
          <strong>The venue you connect</strong> — orders and balance reads go to that venue under your
          key, and its own privacy terms apply.
        </li>
        <li>
          <strong>Optional integrations</strong> — research, AI and notification providers are used
          only when the operator has switched them on and configured a key. When email or Telegram
          delivery is enabled, the alert or ticket content needed for that message is sent to that
          provider.
        </li>
        <li>
          <strong>Mobile wallet pairing</strong> — pairing a phone uses the wallet&apos;s relay, which
          sees the pairing session, not your ledger.
        </li>
        <li>
          <strong>No sale of data.</strong> Nothing here is sold, rented or shared for advertising.
        </li>
      </ul>

      <h2>How long it is kept</h2>
      <p>
        Audit events are kept for the retention window the operator sets on the admin page — deleting
        older events writes its own marker, so a deletion is visible in the trail rather than silent.
        Money and order records are kept while the account exists, because they are the record of what
        happened. Session rows expire and are ended by sign-out or revocation. Support tickets are kept
        while the account is open so a later question can be answered from the same history.
      </p>

      <h2>Your controls</h2>
      <ul>
        <li>
          <strong>Export.</strong> The account page and <code>/api/account/export</code> produce your
          balances, positions, history and totals as CSV or JSON.
        </li>
        <li>
          <strong>Revoke.</strong> Sessions, two-factor enrolment and API keys are yours to end from the
          console at any time.
        </li>
        <li>
          <strong>Ask.</strong> For a correction, a copy in another form, or account closure, contact{" "}
          {OPERATOR_CONTACT}. Closure ends the account&apos;s sessions and stops it trading; financial and
          audit records are retained for the audit window, because deleting them would delete the
          record of money that moved.
        </li>
      </ul>

      <h2>Security</h2>
      <p>
        Venue and integration secrets are encrypted with a server-side key, API keys are stored only as
        hashes, and no secret is sent to the browser. The deployment sets a content-security policy,
        refuses cross-origin state-changing requests, rate-limits sign-in and the money endpoints, and
        records authentication and money actions in the audit trail. No system is perfect: if you
        believe an account is compromised, revoke its sessions and tell the operator through{" "}
        {OPERATOR_CONTACT}.
      </p>

      <p className="policy-disclaimer">
        See also the <Link href="/terms">terms of use</Link> and the{" "}
        <Link href="/risk">risk disclosure</Link>.
      </p>
    </article>
  );
}
