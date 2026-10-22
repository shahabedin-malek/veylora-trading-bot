import type { Metadata } from "next";
import type { ReactNode } from "react";

/**
 * The admin segment's layout.
 *
 * The console's own navigation lives inside the terminal shell (the same shell
 * every admin page uses), so this file deliberately does not draw a second
 * sidebar: it names the segment and gives the pages one container that can be
 * styled without each page repeating a wrapper. `/admin/access`, `/admin/data`,
 * `/admin/risk`, `/admin/fees` and `/admin/models` keep their own routes and
 * render under this layout, which is what keeps the rollback in the phase plan
 * true: reverting the console leaves every older page reachable.
 */
export const metadata: Metadata = {
  title: "Admin console · Veylora",
  description: "Users, balances, ledger, orders, strategies, limits, switches and audit.",
};

export default function AdminLayout({ children }: { children: ReactNode }) {
  return <div className="admin-console-layout">{children}</div>;
}
