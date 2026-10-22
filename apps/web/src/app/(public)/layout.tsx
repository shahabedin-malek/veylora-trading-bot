import type { Metadata } from "next";
import type { ReactNode } from "react";
import { PublicShell } from "@/components/public-shell";

/**
 * The public route group.
 *
 * A route group rather than a path prefix, so `/pricing` stays `/pricing` while the page gets
 * the public shell instead of the console's sidebar. These pages need no session: each one reads
 * only configuration, health or the copy in `src/lib/public/site.ts`.
 */
export const metadata: Metadata = {
  title: {
    default: "Veylora — trading console",
    template: "%s — Veylora",
  },
  description:
    "A trading console for crypto markets: wallet sign-in, a ledger of record, venue orders and readable risk controls. Not a broker, exchange or adviser.",
};

export default function PublicLayout({ children }: { children: ReactNode }) {
  return <PublicShell>{children}</PublicShell>;
}
