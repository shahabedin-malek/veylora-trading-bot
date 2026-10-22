#!/usr/bin/env tsx
/**
 * Re-import an account export and check it against the figures the screen showed.
 *
 * This is the phase's third acceptance criterion made runnable rather than asserted:
 * *an export re-imported by a script reconciles to the same totals*. It asks a running
 * deployment for the same filtered view twice — once as JSON, once as the CSV the
 * **Export** button downloads — re-imports the file through the very parser the test
 * suite uses, and compares three things that must agree:
 *
 *   1. the sum of the file's data rows, per asset;
 *   2. the file's own `TOTAL` rows, per asset;
 *   3. the view's totals for the same filter.
 *
 * Nothing is written and nothing is cached. It reads the owner's own numbers with the
 * session cookie it is given, so it is also the honest check that an export carries
 * what the page carried rather than what a second implementation remembered.
 *
 * Usage
 *   pnpm exec tsx scripts/account-export-reconcile.ts --cookie "veylora_session=…"
 *   pnpm exec tsx scripts/account-export-reconcile.ts --base-url http://localhost:3231 \
 *     --cookie "…" --from 2026-10-01 --to 2026-10-17 --asset USDT --type DEPOSIT_CREDITED
 *
 * Exit codes: 0 = the three agree, 1 = they do not, 2 = the request could not be made.
 */
import { parseHistoryCsv } from "@/lib/portfolio/pnl";

type Args = {
  baseUrl: string;
  cookie: string | null;
  filter: Record<string, string>;
};

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { baseUrl: "http://localhost:3000", cookie: null, filter: {} };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value) continue;
    if (flag === "--base-url") args.baseUrl = value.replace(/\/$/, "");
    else if (flag === "--cookie") args.cookie = value;
    else if (["--from", "--to", "--asset", "--type", "--hash"].includes(flag)) {
      args.filter[flag.slice(2)] = value;
      index += 1;
      continue;
    } else continue;
    index += 1;
  }
  return args;
}

function query(args: Args): string {
  const params = new URLSearchParams(args.filter);
  return params.toString();
}

async function get(args: Args, path: string): Promise<{ status: number; body: string; contentType: string }> {
  const response = await fetch(`${args.baseUrl}${path}`, {
    headers: args.cookie ? { Cookie: args.cookie } : {},
    redirect: "manual",
  });
  return { status: response.status, body: await response.text(), contentType: response.headers.get("content-type") ?? "" };
}

type Totals = { asset: string; netMinor: string }[];

function normalize(totals: Totals): Totals {
  return [...totals].sort((left, right) => left.asset.localeCompare(right.asset));
}

function same(left: Totals, right: Totals): boolean {
  const a = normalize(left);
  const b = normalize(right);
  return a.length === b.length && a.every((entry, index) => entry.asset === b[index]!.asset && entry.netMinor === b[index]!.netMinor);
}

function render(label: string, totals: Totals): string {
  const body = totals.map((total) => `${total.asset} ${total.netMinor}`).join(", ") || "(no assets)";
  return `  ${label.padEnd(28)} ${body}`;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const suffix = query(args) ? `?${query(args)}` : "";

  const view = await get(args, `/api/account${suffix}`);
  if (view.status !== 200) {
    console.error(`The account view answered ${view.status}: ${view.body.slice(0, 200)}`);
    return 2;
  }
  const exported = await get(args, `/api/account/export?format=csv${suffix ? `&${suffix}` : ""}`);
  if (exported.status !== 200) {
    console.error(`The export answered ${exported.status}: ${exported.body.slice(0, 200)}`);
    return 2;
  }

  const payload = JSON.parse(view.body) as {
    range: { from: string; to: string };
    history: { asset: string; amountMinor: string }[];
    totals: { asset: string; netMinor: string }[];
  };
  const parsed = parseHistoryCsv(exported.body);

  const screenRows: Totals = Object.entries(
    payload.history.reduce<Record<string, bigint>>((accumulator, row) => {
      accumulator[row.asset] = (accumulator[row.asset] ?? BigInt(0)) + BigInt(row.amountMinor);
      return accumulator;
    }, {}),
  ).map(([asset, netMinor]) => ({ asset, netMinor: netMinor.toString() }));

  console.log(`Account export reconciliation — ${args.baseUrl}`);
  console.log(`  range                        ${payload.range.from} → ${payload.range.to}`);
  console.log(`  filter                       ${suffix ? suffix.slice(1) : "(none)"}`);
  console.log(`  rows re-imported             ${parsed.rows}`);
  console.log(render("file rows, summed", parsed.summed));
  console.log(render("file TOTAL rows", parsed.totals));
  console.log(render("screen totals", payload.totals));
  console.log(render("screen history rows, summed", screenRows));

  const fileMatchesTotals = same(parsed.summed, payload.totals);
  const fileTotalsMatch = same(parsed.totals, payload.totals);
  const screenRowsMatch = same(screenRows, payload.totals);

  console.log("");
  console.log(`  ${fileMatchesTotals ? "OK " : "FAIL"} the export's rows add up to the screen's totals`);
  console.log(`  ${fileTotalsMatch ? "OK " : "FAIL"} the export's own TOTAL rows carry the screen's totals`);
  console.log(`  ${screenRowsMatch ? "OK " : "FAIL"} the screen's history rows add up to the screen's totals`);

  return fileMatchesTotals && fileTotalsMatch && screenRowsMatch ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  });
