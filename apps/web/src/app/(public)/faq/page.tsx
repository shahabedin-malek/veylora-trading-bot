import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { OPERATOR_CONTACT } from "@/lib/public/site";

/**
 * FAQ.
 *
 * Answers are the behaviour of the implementation, not marketing: the sign-in is a SIWE message,
 * the withdrawal reserves inside the ledger transaction, paper results are never charged, and the
 * mode on the landing page is read from the routing switch. A question whose answer is "it depends
 * on what the operator configured" says exactly that.
 */

export const metadata: Metadata = {
  title: "FAQ",
  description: "Sign-in, keys, paper mode, fees, withdrawals, automation and data — answered from how the console works.",
};

const QUESTIONS: readonly { question: string; answer: ReactNode }[] = [
  {
    question: "How do I sign in?",
    answer: (
      <>
        With a wallet signature and nothing else. The console asks your wallet to sign a message that
        names this site and a one-time value; the server verifies it against the address, so no
        password is stored and none can be phished. Mobile wallets pair by QR or deep link. There is
        no email field to fill in.
      </>
    ),
  },
  {
    question: "Do I have to give you my exchange keys?",
    answer: (
      <>
        Only if you want orders sent to an exchange. A key is stored encrypted, used for the actions
        you take here, and shown back only as a fingerprint. Read-only keys are the recommended start:
        they can read balances and cannot move funds. You can revoke a key here, and the venue&apos;s own
        dashboard is always the final word.
      </>
    ),
  },
  {
    question: "Paper, testnet or live — what am I looking at?",
    answer: (
      <>
        The landing page and the trading view state the mode, read from the routing switch rather than
        written into the page. <strong>Paper</strong> orders fill against the console&apos;s own book and
        never reach a venue. <strong>Testnet</strong> orders go to a sandbox venue with play money.{" "}
        <strong>Live</strong> orders reach a real venue and only while the operator&apos;s live switch is
        on. A backtest or paper result is not evidence of live performance.
      </>
    ),
  },
  {
    question: "How does the fee work?",
    answer: (
      <>
        Withdrawals carry a platform fee deducted from the amount you authorise, plus a network cost
        the platform pays rather than deducting. Strategies pay a percentage of a profitable live
        result and nothing on a loss; paper and backtest results are never charged. Deposits are free
        and there is no subscription. The figures are on <Link href="/pricing">pricing</Link>, read
        from the same table the code charges.
      </>
    ),
  },
  {
    question: "How long does a withdrawal take?",
    answer: (
      <>
        A withdrawal reserves the amount in the ledger immediately, so the same balance cannot be spent
        twice, and then goes to the network. It is broadcast, confirmed and marked complete as the
        chain confirms it; while it is in flight the row says which stage it is at and any reason it is
        waiting. A destination you have not used before may be held for a window the operator
        configured. On-chain transfers cannot be recalled.
      </>
    ),
  },
  {
    question: "What happens if a strategy loses money while I am away?",
    answer: (
      <>
        It keeps trading within the limits the operator set — a cap per order, a daily cap, an
        allowed-venue list and two kill switches (global and per strategy). The runner continues
        without your browser open, which is the point of it, and it writes a decision for every window,
        including the ones where it did nothing and why. If you want it to stop, stop the strategy or
        press the kill switch.
      </>
    ),
  },
  {
    question: "Can I use the API or an MCP client?",
    answer: (
      <>
        Yes. The public API is scoped by key (<code>read</code>, <code>trade</code>,{" "}
        <code>agent</code>), rate-limited per key, and documented at <Link href="/docs/api">/docs/api</Link>{" "}
        from the same registry the handler dispatches. A trade-scoped key acts only in the dedicated
        agent account it names, never your main account. The MCP server exposes the same surface to a
        compatible client.
      </>
    ),
  },
  {
    question: "What do you store about me, and can I take it with me?",
    answer: (
      <>
        Wallet address, sessions (device label, IP, times), money and trading records, security
        material in hashed or encrypted form, audit events with redacted payloads, and any support
        messages you write. No email, no name, no card, no analytics. The account page and{" "}
        <code>/api/account/export</code> give you the whole record as CSV or JSON. The{" "}
        <Link href="/privacy">privacy page</Link> lists each category.
      </>
    ),
  },
  {
    question: "How do I know the console is honest about a number?",
    answer: (
      <>
        Each surface says where its figures come from. Prices carry a provider and a read time; a
        balance is the sum of ledger entries, not a stored column; the fee page is the table the
        withdrawal path charges; the status page is the health snapshot, read live. When a source
        cannot be read, the surface says so instead of showing a stale value as if it were current.
      </>
    ),
  },
  {
    question: "Something is wrong. Who do I tell?",
    answer: (
      <>
        Use {OPERATOR_CONTACT}. For a suspected compromise, revoke the sessions from the account page
        first, then write — the audit trail will show what happened, and a revoked session stops
        working on the next request.
      </>
    ),
  },
];

export default function FaqPage() {
  return (
    <article className="public-prose">
      <p className="eyebrow">HELP <span className="eyebrow-separator">/</span> FAQ</p>
      <h1>Questions people ask first</h1>
      <p>
        Short answers, each describing what the deployment actually does. Where an answer depends on a
        setting, it says so instead of promising a number.
      </p>

      <div className="public-faq">
        {QUESTIONS.map((item, index) => (
          <details key={item.question} open={index === 0}>
            <summary>{item.question}</summary>
            <p>{item.answer}</p>
          </details>
        ))}
      </div>

      <p className="policy-disclaimer">
        Still stuck? <Link href="/docs">Docs</Link>, the <Link href="/risk">risk disclosure</Link> and
        the <Link href="/status">status page</Link> cover the rest.
      </p>
    </article>
  );
}
