import { connection } from "next/server";
import { redirect } from "next/navigation";
import { AccessNotice } from "@/components/access-notice";
import { AccountOverview } from "@/components/account-overview";
import { TerminalShell } from "@/components/terminal-shell";
import { checkPageAccess } from "@/lib/auth/access-gate";

export const instant = false;

const CAPABILITY = "The account overview is your own balances, so it needs a signed-in account";

export default async function AccountPage() {
  await connection();
  const access = await checkPageAccess({ kind: "user" });
  if (access.status === "unconfigured") {
    return (
      <TerminalShell active="account" section="ACCOUNT">
        <AccessNotice capability={CAPABILITY} reason={access.reason} />
      </TerminalShell>
    );
  }
  if (access.status === "anonymous") redirect("/login");

  return (
    <TerminalShell active="account" section="ACCOUNT">
      <section className="page-heading" aria-labelledby="account-page-title">
        <div className="page-heading__copy">
          <div className="eyebrow">
            <span className="eyebrow-line" aria-hidden="true" />
            ONE PLACE <span className="eyebrow-separator">/</span> WHERE THE MONEY IS
          </div>
          <h1 id="account-page-title">Account</h1>
          <p>
            Balances, positions and profit, the full history behind them, the assistant&apos;s own paper orders
            replayed against its fills, and an export of exactly what you are looking at. Every figure states where it
            came from and when it was read, and nothing here is a stored total: the balances are the ledger&apos;s own
            entries added up, and the export carries the same rows.
          </p>
        </div>
      </section>

      <AccountOverview />
    </TerminalShell>
  );
}
