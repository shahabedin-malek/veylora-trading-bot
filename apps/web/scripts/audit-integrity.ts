#!/usr/bin/env tsx
/**
 * Verify the audit hash chain and exit non-zero when it is broken.
 *
 * This is the command an operator runs after an incident, and the one the manual
 * verification for phase 36 names: it prints the first broken link (modified,
 * missing or mislinked) rather than a count, so the answer is actionable. The
 * runner job calls the same verifier on a schedule; this CLI is the same check
 * with an exit status a shell or a monitor can act on.
 *
 * Usage:
 *   pnpm audit:verify
 *   DATABASE_URL=file:./some-copy.db pnpm audit:verify
 */
import { readAuditRetention } from "@/lib/audit/retention";
import { verifyAuditChain } from "@/lib/audit/verify";
import { prisma } from "@/lib/db";

async function main() {
  const report = await verifyAuditChain(prisma);
  const retention = await readAuditRetention().catch(() => null);

  console.log(
    JSON.stringify(
      {
        ok: report.ok,
        checked: report.checked,
        chainLength: report.chainLength,
        headIndex: report.headIndex,
        headHash: report.headHash,
        legacyRows: report.legacyRows,
        gaps: report.gaps,
        retentionWindowDays: retention?.windowDays ?? null,
        verifiedAt: report.verifiedAt,
        firstBroken: report.firstBroken,
      },
      null,
      2,
    ),
  );

  if (report.firstBroken) {
    console.error(
      `\nAudit chain is broken at index ${report.firstBroken.chainIndex}: ${report.firstBroken.kind}\n${report.firstBroken.message}`,
    );
  }

  await prisma.$disconnect();
  process.exitCode = report.ok ? 0 : 1;
}

void main();
