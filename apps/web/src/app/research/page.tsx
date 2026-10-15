import { redirect } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { DepthText } from "@/components/depth-text";
import { TerminalShell } from "@/components/terminal-shell";
import { AuthenticationRequiredError, requireUser } from "@/lib/auth/session-store";
import { getIntegrationFeatureSettings } from "@/lib/integrations/settings";
import { ResearchDesk } from "./research-desk";

async function ResearchContent() {
  await connection();
  try {
    await requireUser();
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) redirect("/login");
    throw error;
  }

  const settings = await getIntegrationFeatureSettings().catch(() => null);
  return (
    <TerminalShell active="research" section="RESEARCH">
      <section className="page-heading" aria-labelledby="research-title">
        <div className="page-heading__copy">
          <div className="eyebrow"><span className="eyebrow-line" aria-hidden="true" />PUBLIC WEB / SOURCE REVIEW</div>
          <h1 id="research-title"><DepthText text="Research" /></h1>
          <p>Search current web sources or extract a public page for review. Results are informational and stay outside Veylora’s trading and risk systems.</p>
        </div>
        <span className="section-state">TAVILY / KEYLESS</span>
      </section>
      <section className="data-section" aria-labelledby="research-tools-title">
        <div className="section-heading">
          <div><div className="section-kicker">01 / WEB RESEARCH</div><h2 id="research-tools-title">Search and extract</h2></div>
          <span className="section-state">NO API KEY / FREE TIER</span>
        </div>
        <ResearchDesk settings={settings} />
      </section>
    </TerminalShell>
  );
}

export default function ResearchPage() {
  return (
    <Suspense fallback={<div className="market-chart-empty" role="status"><strong>Checking account access</strong></div>}>
      <ResearchContent />
    </Suspense>
  );
}