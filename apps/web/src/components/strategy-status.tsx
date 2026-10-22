import type { StrategyDecisionFeed, StrategyDecisionRecord } from "@/lib/strategies/runner";

/**
 * What the strategy runner has been doing, per strategy.
 *
 * Phase 24 requirement 6 asks for enough on screen to answer "is it working" without logs:
 * the running state, the last decision with its time and reason, the next expected pass and
 * a run count. Everything here is the record the runner wrote — the same row the admin
 * console and the audit trail can see — rather than a second opinion computed in the page.
 *
 * The reason list is rendered from the taxonomy module, so a code that exists but is not
 * shown yet is a visible gap rather than an invisible one.
 */

function time(value: string | null): string {
  return value ? new Date(value).toISOString().replace("T", " ").replace(".000Z", "Z") : "not yet";
}

function outcomeLabel(record: StrategyDecisionRecord): string {
  return record.outcome === "ORDER_PLACED" ? "ORDER PLACED" : record.outcome === "ERROR" ? "ERROR" : "NO ACTION";
}

function DecisionRow({ record }: { record: StrategyDecisionRecord }) {
  return (
    <tr>
      <td>{time(record.evaluatedAt)}</td>
      <td>{record.windowStart.slice(0, 16).replace("T", " ")}</td>
      <td>{outcomeLabel(record)}</td>
      <td>
        <strong>{record.reason.label}</strong>
        <br />
        <small>{record.reason.message}</small>
      </td>
      <td>{record.orderId ? <code>{record.orderId}</code> : "—"}</td>
    </tr>
  );
}

export function StrategyStatus({ feed }: { feed: StrategyDecisionFeed }) {
  const last = feed.lastDecision;
  const inputs = last?.inputs ?? {};
  const documented = feed.taxonomy.filter((entry) => entry.taxonomy);

  return (
    <div className="strategy-status">
      <div className="section-heading">
        <div>
          <div className="section-kicker">AUTOMATION / LAST DECISION</div>
          <h3>Strategy runner</h3>
        </div>
        <span className="section-state">
          {feed.running ? "RUNNING 24/7" : "STOPPED"}
        </span>
      </div>

      <p className="trading-security-note">
        The runner evaluates this strategy once per {feed.intervalMinutes ?? "—"} minute
        {feed.intervalMinutes === 1 ? "" : "s"} on {feed.market ?? "its market"}, whether or not a browser is
        open. Every evaluation is one row below: the inputs it read, the conditions it compared, the outcome and the
        reason. A pass that lands in an interval that already has a decision writes nothing, so a redeploy or a
        repeated delivery cannot place a second order.
      </p>

      <dl className="strategy-status__facts">
        <div>
          <dt>STRATEGY</dt>
          <dd>{feed.strategyLabel ?? "No strategy selected"}</dd>
        </div>
        <div>
          <dt>NEXT PASS</dt>
          <dd>{time(feed.nextPassAt)}</dd>
        </div>
        <div>
          <dt>PASSES RECORDED</dt>
          <dd>{feed.runCount}</dd>
        </div>
        <div>
          <dt>LAST DECISION</dt>
          <dd>{last ? time(last.evaluatedAt) : "none yet"}</dd>
        </div>
      </dl>

      {last ? (
        <div className="strategy-status__last" role="status">
          <div className="section-kicker">{outcomeLabel(last)} · {last.reason.label}</div>
          <p>{last.reason.message}</p>
          {last.conditions.length > 0 ? (
            <table className="market-history-table">
              <thead>
                <tr>
                  <th scope="col">Condition</th>
                  <th scope="col">Value</th>
                  <th scope="col">Threshold</th>
                  <th scope="col">Met</th>
                </tr>
              </thead>
              <tbody>
                {last.conditions.map((condition) => (
                  <tr key={condition.id}>
                    <td>{condition.label}</td>
                    <td>{condition.value}</td>
                    <td>{condition.threshold}</td>
                    <td>{condition.met ? "YES" : "NO"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          {Object.keys(inputs).length > 0 ? (
            <details>
              <summary>Inputs this decision used</summary>
              <pre>{JSON.stringify(inputs, null, 2)}</pre>
            </details>
          ) : null}
        </div>
      ) : (
        <p className="policy-disclaimer" role="status">
          No decision has been recorded for this strategy yet. Start smart trading (or wait for the next pass) and the
          runner&apos;s first evaluation appears here.
        </p>
      )}

      <div className="section-heading">
        <div>
          <div className="section-kicker">HISTORY</div>
          <h4>Recent decisions</h4>
        </div>
        <span className="section-state">{feed.decisions.length} SHOWN</span>
      </div>
      {feed.decisions.length > 0 ? (
        <div className="market-history-table-wrap">
          <table className="market-history-table">
            <thead>
              <tr>
                <th scope="col">Decided at</th>
                <th scope="col">Window</th>
                <th scope="col">Outcome</th>
                <th scope="col">Reason</th>
                <th scope="col">Order</th>
              </tr>
            </thead>
            <tbody>
              {feed.decisions.map((record) => (
                <DecisionRow key={record.id} record={record} />
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="policy-disclaimer" role="status">
          No decisions are stored for this strategy yet.
        </p>
      )}

      <div className="section-heading">
        <div>
          <div className="section-kicker">TAXONOMY</div>
          <h4>Reasons this runner can report</h4>
        </div>
        <span className="section-state">{documented.length} IDLE REASONS</span>
      </div>
      <ul className="strategy-status__reasons">
        {documented.map((entry) => (
          <li key={entry.code}>
            <strong>{entry.label}</strong> <code>{entry.code}</code>
          </li>
        ))}
      </ul>
      <p className="trading-security-note">
        These are the reasons an idle pass can name. `STRATEGY_DISABLED`, `RISK_LIMIT_REACHED` and
        `RUNNER_MISSED_WINDOW` are the owner-side ones; the credential, balance, venue and rate-limit reasons come from
        the order path&apos;s own answer, and a decision that placed records the entry, exit or stop-loss that placed it.
      </p>
    </div>
  );
}
