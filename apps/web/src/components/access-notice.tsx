/**
 * What a page shows when the deployment cannot sign anybody in.
 *
 * This is deliberately not a hidden page and not a redirect into a sign-in
 * screen that cannot work: the shell, the navigation and the heading stay, and
 * the body says which configuration name is missing. The page renders its real
 * content again as soon as that name is set, with no code change.
 */
export function AccessNotice({ reason, capability }: { reason: string; capability: string }) {
  return (
    <section className="data-section" aria-labelledby="access-notice-title">
      <div className="section-heading">
        <div>
          <div className="section-kicker">SIGN-IN NOT CONFIGURED</div>
          <h2 id="access-notice-title">{capability}</h2>
        </div>
        <span className="section-state">CONFIGURATION REQUIRED</span>
      </div>
      <div className="market-chart-empty" role="status">
        <strong>{reason}</strong>
        <span>
          This page needs a signed-in account. Set the name above (see .env.example), restart the dev
          server, and sign in with the owner wallet; the page then renders its full content.
        </span>
      </div>
    </section>
  );
}
