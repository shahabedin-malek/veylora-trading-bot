import { ExternalLink, Sparkles } from "lucide-react";
import { connection } from "next/server";
import { Suspense } from "react";
import { CHAINGPT_FEATURES } from "@/lib/chaingpt/features";
import { getChainGPTFeatureSettings } from "@/lib/chaingpt/settings";
import { TerminalShell } from "@/components/terminal-shell";

async function ChainGPTContent() {
  await connection();

  let settings;
  try {
    settings = await getChainGPTFeatureSettings();
  } catch {
    settings = null;
  }

  const enabledFeatures = settings
    ? CHAINGPT_FEATURES.filter((feature) => settings[feature.key])
    : [];

  return (
    <TerminalShell active="chaingpt" section="CHAINGPT TOOLS">
      <section className="page-heading" aria-labelledby="chaingpt-title">
        <div className="page-heading__copy">
          <div className="eyebrow">
            <span className="eyebrow-line" aria-hidden="true" />
            EXTERNAL TOOLS <span className="eyebrow-separator">/</span> LINK DIRECTORY
          </div>
          <h1 id="chaingpt-title">ChainGPT tools</h1>
          <p>Open ChainGPT’s hosted Web3 tools. Veylora does not connect its API or send your account, wallet, or portfolio data.</p>
        </div>
        <span className="section-state">EXTERNAL / NO API</span>
      </section>

      <section className="data-section chaingpt-section" aria-labelledby="chaingpt-links-title">
        <div className="section-heading">
          <div>
            <div className="section-kicker">HOSTED BY CHAINGPT</div>
            <h2 id="chaingpt-links-title">Available tools</h2>
          </div>
          <span className="section-state">{enabledFeatures.length} ENABLED</span>
        </div>

        {settings === null ? (
          <div className="market-chart-empty" role="status">
            <strong>Tool settings unavailable</strong>
            <span>No external links are shown until the settings store is available.</span>
          </div>
        ) : enabledFeatures.length === 0 ? (
          <div className="market-chart-empty" role="status">
            <strong>No ChainGPT links enabled</strong>
            <span>An administrator can enable hosted tools from Access settings.</span>
          </div>
        ) : (
          <ul className="chaingpt-feature-list">
            {enabledFeatures.map((feature) => (
              <li className="chaingpt-feature-row" key={feature.key}>
                <div className="chaingpt-feature-copy">
                  <span className="chaingpt-feature-name">{feature.name}</span>
                  <span className="chaingpt-feature-detail">{feature.detail}</span>
                </div>
                <a className="section-action chaingpt-feature-link" href={feature.href} target="_blank" rel="noopener noreferrer">
                  <Sparkles aria-hidden="true" size={13} />
                  OPEN <ExternalLink aria-hidden="true" size={12} />
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="chaingpt-disclosure">Free quotas and eligibility are controlled by ChainGPT and may change. AI output is informational only; it does not authorize trades or replace Veylora’s risk controls. On-chain actions may incur network fees.</p>
    </TerminalShell>
  );
}

export default function ChainGPTPage() {
  return (
    <Suspense fallback={<div className="market-chart-empty" role="status"><strong>Loading ChainGPT links</strong></div>}>
      <ChainGPTContent />
    </Suspense>
  );
}