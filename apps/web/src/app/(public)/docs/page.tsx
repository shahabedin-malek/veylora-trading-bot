import type { Metadata } from "next";
import Link from "next/link";
import { API_DOCS_PATH, API_RATE_LIMIT_DEFAULT } from "@/lib/api/docs";
import { LEGAL_NAVIGATION, OPERATOR_CONTACT } from "@/lib/public/site";

/**
 * The documentation index.
 *
 * It holds no facts of its own: the route to the reference comes from the same constant the
 * API handler is mounted at, the rate limit from the published ceiling, and the setup commands
 * from the README that CI runs. A docs page that restated an endpoint list would be a second
 * source of truth, which is exactly what phase 32 avoided by generating `/docs/api` from the
 * dispatcher's registry.
 */

export const metadata: Metadata = {
  title: "Docs",
  description: "How the console is put together, the public API, the MCP server and how to run the app locally.",
};

export default function DocsPage() {
  return (
    <div className="public-prose">
      <p className="eyebrow">DOCUMENTATION</p>
      <h1>Read the thing before you wire it up</h1>
      <p>
        The console is a Next.js application with a PostgreSQL schema, a ledger of record, and one
        route layer that the public API, the MCP server and the pages all read from. These pages
        describe what exists in this deployment; where a surface is still a skeleton, it says so.
      </p>

      <h2>What is documented here</h2>
      <ul>
        <li>
          <Link href={API_DOCS_PATH}>API and MCP reference</Link> — every route, scope and body
          the <code>{API_DOCS_PATH}</code> handler dispatches, generated from the registry rather than
          written by hand. The default rate limit is {API_RATE_LIMIT_DEFAULT} requests per minute per key.
        </li>
        <li>
          <Link href="/pricing">Pricing</Link> — the fee table the code charges, rendered from the
          stored version.
        </li>
        <li>
          <Link href="/status">Status</Link> — the health snapshot and the runner&apos;s heartbeats, read
          at the moment the page loads.
        </li>
        {LEGAL_NAVIGATION.map((item) => (
          <li key={item.href}>
            <Link href={item.href}>{item.label}</Link>
          </li>
        ))}
      </ul>

      <h2>Running it yourself</h2>
      <p>From a clean checkout of the repository, three commands bring up a seeded local instance:</p>
      <pre className="policy-disclaimer">
        <code>{`pnpm install --dir apps/web\npnpm --dir apps/web db:setup\npnpm --dir apps/web dev`}</code>
      </pre>
      <p>
        The development database is a SQLite file the pipeline creates and owns, so no credential is
        needed to run the app. A production deployment reads <code>DATABASE_URL</code> from the
        environment and applies its migrations before the build serves traffic.
      </p>

      <h2>What the numbers mean</h2>
      <p>
        A balance is the sum of ledger entries, never a stored column, so every figure on the account
        page can be traced to the movements that produced it. An order carries a status, an
        idempotency key and its attempts; a withdrawal reserves inside the same transaction that
        records it. Where a provider could not be reached, the surface names the provider and the time
        instead of showing a stale value as if it were live.
      </p>

      <h2>Getting help</h2>
      <p>
        For anything not answered here, use {OPERATOR_CONTACT}. The{" "}
        <Link href="/faq">FAQ</Link> covers sign-in, keys, paper mode, fees and withdrawals in the
        order people usually hit them.
      </p>
    </div>
  );
}
