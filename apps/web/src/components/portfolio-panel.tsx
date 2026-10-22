"use client";

import { Plus, RefreshCw, ShieldAlert, Trash2, Wallet } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  DEFAULT_EVM_MAINNET_CHAIN_ID,
  EVM_MAINNETS,
  MAX_ADDITIONAL_EVM_MAINNETS,
} from "@/lib/portfolio/evm-mainnets";
import { normalizeChecksummedAddress } from "@/lib/portfolio/ethereum-token-allowlist";
import type { NetworkPortfolio, PortfolioSummary } from "@/lib/portfolio/positions";

type AnnouncedNetwork = { network: string; networkName: string; chainId: number };
type AllowListEntry = { chainId: number; contractAddress: string };
type SummaryEvent = { status: string; readAt: string; summary: PortfolioSummary; warnings: string[] };

type Phase = "loading" | "ready" | "partial" | "unauthorized" | "error";

function textOf(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  for (const key of ["error", "message"]) {
    const value = (body as Record<string, unknown>)[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function amountLine(symbol: string, amount: string): string {
  return `${amount} ${symbol}`;
}

function networkKey(network: string): string {
  return network;
}

function HoldingRow({ holding, walletAddress }: {
  holding: NetworkPortfolio["holdings"][number];
  walletAddress: string | null;
}) {
  const link = holding.contractAddress && holding.explorerUrl
    ? `${holding.explorerUrl}/token/${holding.contractAddress}`
    : holding.explorerUrl && walletAddress && holding.assetType === "native"
      ? `${holding.explorerUrl}/address/${walletAddress}`
      : null;
  return (
    <li className="portfolio-holding">
      <div className="portfolio-holding__asset">
        <strong>{holding.symbol}</strong>
        <span>{holding.name ?? (holding.assetType === "native" ? "native asset" : "token")}</span>
      </div>
      <div className="portfolio-holding__amount">
        <strong>{holding.formattedAmount}</strong>
        <span>{holding.decimals} decimals · {holding.providerId}</span>
      </div>
      <div className="portfolio-holding__markers">
        {holding.assetType === "token" && (
          <span className={holding.allowListed ? "holding-chip holding-chip--ok" : "holding-chip holding-chip--warn"}>
            {holding.allowListed ? "allow-listed" : "not in allow-list"}
          </span>
        )}
        {holding.suspectedSpam && (
          <span className="holding-chip holding-chip--alert"><ShieldAlert aria-hidden="true" size={10} /> marked as possible spam</span>
        )}
        {holding.markers
          .filter((marker) => marker !== "not in allow-list")
          .map((marker) => <span className="holding-chip" key={marker}>{marker}</span>)}
      </div>
      <details className="portfolio-holding__inspect">
        <summary>Inspect</summary>
        <dl>
          <div><dt>RAW AMOUNT</dt><dd>{holding.rawAmount}</dd></div>
          <div><dt>CONTRACT</dt><dd>{holding.contractAddress ?? "native asset — no contract"}</dd></div>
          <div><dt>READ AT</dt><dd>{holding.readAt}</dd></div>
          <div><dt>SOURCE</dt><dd>{holding.providerId} · chain {holding.chainId}</dd></div>
          {link && <div><dt>EXPLORER</dt><dd><a href={link} rel="noreferrer" target="_blank">open on explorer</a></dd></div>}
        </dl>
      </details>
    </li>
  );
}

function NetworkRow({ announced, row, walletAddress }: {
  announced: AnnouncedNetwork;
  row: NetworkPortfolio | undefined;
  walletAddress: string | null;
}) {
  return (
    <li className="portfolio-network" data-network={announced.network}>
      <div className="portfolio-network__heading">
        <div>
          <strong>{announced.networkName}</strong>
          <small>
            CHAIN {announced.chainId} · {
              !row ? "READING…"
                : row.status === "available" ? `${row.holdings.length} HOLDING${row.holdings.length === 1 ? "" : "S"}`
                  : row.status === "timeout" ? "TIMED OUT"
                    : "UNAVAILABLE"
            }
          </small>
        </div>
        <span className={`portfolio-network__state portfolio-network__state--${row?.status ?? "pending"}`}>
          {row?.status === "available" ? "ANSWERED" : row?.status === "timeout" ? "TIMEOUT" : row ? "NO ANSWER" : "PENDING"}
        </span>
      </div>

      {row && row.status !== "available" && (
        <p className="portfolio-network__reason" role="status">{row.reason}</p>
      )}

      {row?.status === "available" && (
        <>
          {row.holdings.length === 0 ? (
            <p className="portfolio-network__empty">No balance on this network. An empty read is a reading, not a failure.</p>
          ) : (
            <ul className="portfolio-holdings">
              {row.holdings.map((holding) => (
                <HoldingRow
                  holding={holding}
                  key={`${holding.contractAddress ?? "native"}-${holding.symbol}`}
                  walletAddress={walletAddress}
                />
              ))}
            </ul>
          )}
          {row.totals.byAsset.length > 0 && (
            <p className="portfolio-network__totals">
              NETWORK TOTAL · {row.totals.byAsset.map(({ symbol, amount }) => amountLine(symbol, amount)).join(" · ")}
            </p>
          )}
          <p className="portfolio-network__provenance">
            {row.providerId ?? "no provider"} · metadata {row.metadata ?? "not cached"} · {row.readAt}
            {row.truncated > 0 ? ` · ${row.truncated} further contract(s) not shown` : ""}
          </p>
          {row.warnings.length > 0 && (
            <ul className="portfolio-network__warnings">
              {row.warnings.map((warning) => <li key={warning}>{warning}</li>)}
            </ul>
          )}
        </>
      )}
    </li>
  );
}

export function PortfolioPanel() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [announced, setAnnounced] = useState<AnnouncedNetwork[]>([]);
  const [rows, setRows] = useState<Record<string, NetworkPortfolio>>({});
  const [summary, setSummary] = useState<PortfolioSummary | null>(null);
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [readAt, setReadAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [allowList, setAllowList] = useState<AllowListEntry[]>([]);
  const [request, setRequest] = useState({ seq: 0, refresh: false });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [networkToAdd, setNetworkToAdd] = useState("");
  const [tokenChainId, setTokenChainId] = useState(DEFAULT_EVM_MAINNET_CHAIN_ID);
  const [tokenAddress, setTokenAddress] = useState("");

  useEffect(() => {
    const controller = new AbortController();

    const acceptSnapshot = (body: unknown) => {
      if (typeof body !== "object" || body === null) {
        setPhase("error");
        setError("The portfolio response was not readable.");
        return;
      }
      const record = body as {
        status?: string;
        walletAddress?: string;
        readAt?: string;
        networks?: NetworkPortfolio[];
        summary?: PortfolioSummary;
        allowList?: AllowListEntry[];
        error?: string;
      };
      if (record.error) {
        setPhase("error");
        setError(record.error);
        return;
      }
      setWalletAddress(record.walletAddress ?? null);
      setReadAt(record.readAt ?? null);
      setAnnounced((record.networks ?? []).map(({ network, networkName, chainId }) => ({ network, networkName, chainId })));
      setRows(Object.fromEntries((record.networks ?? []).map((row) => [networkKey(row.network), row])));
      setSummary(record.summary ?? null);
      setAllowList(record.allowList ?? []);
      if ((record.networks ?? []).length === 0) {
        setPhase("ready");
        return;
      }
      setPhase(record.summary?.complete ? "ready" : record.summary?.answered ? "partial" : "error");
      if (!record.summary?.answered) setError("No network answered. The failures are listed below.");
    };

    void (async () => {
      try {
        const response = await fetch(`/api/portfolio${request.refresh ? "?refresh=1" : ""}`, {
          cache: "no-store",
          credentials: "same-origin",
          headers: { Accept: "text/event-stream" },
          signal: controller.signal,
        });

        const contentType = response.headers.get("content-type") ?? "";
        if (!response.ok || !contentType.includes("text/event-stream") || !response.body) {
          const body: unknown = await response.json().catch(() => null);
          if (response.status === 401 || response.status === 403) {
            setPhase("unauthorized");
            setError(textOf(body) ?? "Connect a verified wallet to read this portfolio.");
            return;
          }
          acceptSnapshot(body);
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let separator = buffer.indexOf("\n\n");
          while (separator !== -1) {
            const chunk = buffer.slice(0, separator);
            buffer = buffer.slice(separator + 2);
            separator = buffer.indexOf("\n\n");

            const eventLine = chunk.split("\n").find((line) => line.startsWith("event:"));
            const dataLine = chunk.split("\n").find((line) => line.startsWith("data:"));
            if (!eventLine || !dataLine) continue;
            const event = eventLine.slice("event:".length).trim();
            let payload: unknown;
            try {
              payload = JSON.parse(dataLine.slice("data:".length).trim());
            } catch {
              continue;
            }

            if (event === "start") {
              const start = payload as { walletAddress?: string; readAt?: string; networks?: AnnouncedNetwork[]; allowList?: AllowListEntry[] };
              setWalletAddress(start.walletAddress ?? null);
              setReadAt(start.readAt ?? null);
              setAnnounced(start.networks ?? []);
              setAllowList(start.allowList ?? []);
            } else if (event === "network") {
              const row = payload as NetworkPortfolio;
              setRows((current) => ({ ...current, [networkKey(row.network)]: row }));
            } else if (event === "summary") {
              const result = payload as SummaryEvent;
              setSummary(result.summary);
              if (result.summary.networks === 0) {
                setPhase("ready");
              } else {
                setPhase(result.summary.complete ? "ready" : result.summary.answered ? "partial" : "error");
                if (!result.summary.answered) setError("No network answered. The failures are listed below.");
              }
            } else if (event === "error") {
              setPhase("error");
              setError(textOf(payload) ?? "The portfolio read failed.");
            }
          }
        }
      } catch (cause) {
        if (controller.signal.aborted) return;
        setPhase("error");
        setError(cause instanceof Error ? `Portfolio could not be requested: ${cause.message}` : "Portfolio could not be requested.");
      }
    })();

    return () => controller.abort();
  }, [request]);

  // Failed and pending networks first: the row that needs explaining should not
  // sit under a hundred holdings from a network that answered.
  const orderedNetworks = useMemo(() => {
    const rank = (network: AnnouncedNetwork) => {
      const row = rows[networkKey(network.network)];
      if (!row) return 1;
      return row.status === "available" ? 2 : 0;
    };
    return [...announced].sort((left, right) => rank(left) - rank(right));
  }, [announced, rows]);

  const enabledChainIds = useMemo(
    () => new Set([...announced.map(({ chainId }) => chainId), ...allowList.map(({ chainId }) => chainId)]),
    [announced, allowList],
  );
  const addableNetworks = EVM_MAINNETS.filter(({ chainId }) => !enabledChainIds.has(chainId));
  const tokenNetworks = announced.length > 0
    ? announced
    : EVM_MAINNETS.filter(({ chainId }) => chainId === DEFAULT_EVM_MAINNET_CHAIN_ID)
      .map(({ chainId, name, alchemyNetwork }) => ({ chainId, networkName: name, network: alchemyNetwork }));
  const activeTokenChainId = tokenNetworks.some(({ chainId }) => chainId === tokenChainId)
    ? tokenChainId
    : tokenNetworks[0]?.chainId ?? DEFAULT_EVM_MAINNET_CHAIN_ID;
  const activeTokenContracts = allowList.filter(({ chainId }) => chainId === activeTokenChainId);
  const additionalCount = announced.filter(({ chainId }) => chainId !== DEFAULT_EVM_MAINNET_CHAIN_ID).length;
  const settingsDisabled = busy || phase === "unauthorized" || phase === "loading";

  // Clearing here, in the event that asks for a new read, rather than at the top
  // of the effect: the effect then only subscribes to the request, and a reload
  // starts from an empty read instead of showing the previous network's rows.
  function reload(refresh = false) {
    setPhase("loading");
    setError(null);
    setSummary(null);
    setRows({});
    setAnnounced([]);
    setReadAt(null);
    setRequest((current) => ({ seq: current.seq + 1, refresh }));
  }

  async function mutate(path: string, method: "POST" | "DELETE", body: unknown): Promise<boolean> {
    setSettingsError(null);
    setBusy(true);
    try {
      const response = await fetch(path, {
        method,
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        setSettingsError(textOf(result) ?? "The change could not be saved.");
        return false;
      }
      reload();
      return true;
    } catch (cause) {
      setSettingsError(cause instanceof Error ? cause.message : "The change could not be saved.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function addNetwork(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!networkToAdd) return;
    const chainId = Number(networkToAdd);
    if (!Number.isSafeInteger(chainId)) return;
    if (await mutate("/api/portfolio/networks", "POST", { chainId })) setNetworkToAdd("");
  }

  async function removeNetwork(chainId: number) {
    if (await mutate("/api/portfolio/networks", "DELETE", { chainId })) {
      setAllowList((current) => current.filter((entry) => entry.chainId !== chainId));
    }
  }

  async function addContract(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const contractAddress = normalizeChecksummedAddress(tokenAddress.trim());
    if (!contractAddress) {
      setSettingsError("Enter a valid EVM contract address; it is stored in checksum form.");
      return;
    }
    if (await mutate("/api/portfolio/ethereum/tokens", "POST", { chainId: activeTokenChainId, contractAddress })) {
      setTokenAddress("");
    }
  }

  async function removeContract(chainId: number, contractAddress: string) {
    if (await mutate("/api/portfolio/ethereum/tokens", "DELETE", { chainId, contractAddress })) {
      setAllowList((current) => current.filter((entry) => !(entry.chainId === chainId && entry.contractAddress === contractAddress)));
    }
  }

  const answered = summary?.answered ?? Object.values(rows).filter(({ status }) => status === "available").length;
  const totalNetworks = summary?.networks ?? announced.length;
  const missing = summary?.missing ?? [];
  const stateLabel = phase === "loading"
    ? "READING NETWORKS"
    : phase === "unauthorized"
      ? "SIGN-IN REQUIRED"
      : phase === "error"
        ? "NO READ"
        : summary?.complete ? `${answered} NETWORKS` : `PARTIAL ${answered}/${totalNetworks}`;

  return (
    <section className="data-section portfolio-section" id="portfolio" aria-labelledby="portfolio-title">
      <div className="section-heading">
        <div>
          <div className="section-kicker">02 / ALL EVM NETWORKS</div>
          <h2 id="portfolio-title">Portfolio</h2>
        </div>
        <span className="section-state" aria-live="polite">{stateLabel}</span>
      </div>

      {phase === "unauthorized" && (
        <div className="portfolio-empty" role="status">
          <div className="portfolio-glyph" aria-hidden="true"><Wallet size={20} strokeWidth={1.5} /></div>
          <strong>{error ?? "Connect a verified wallet to read this portfolio."}</strong>
          <p>No balance is inferred, and no network is hidden.</p>
        </div>
      )}

      {phase !== "unauthorized" && (
        <>
          <div className="portfolio-aggregate">
            <div className="portfolio-aggregate__heading">
              <span>
                AGGREGATE · {answered} OF {totalNetworks} NETWORKS
                {summary ? ` · ${summary.totals.byAsset.length} ASSETS` : ""}
              </span>
              <button
                className="portfolio-refresh"
                disabled={phase === "loading"}
                onClick={() => reload(true)}
                type="button"
              >
                <RefreshCw aria-hidden="true" size={11} /> REFRESH METADATA
              </button>
            </div>

            {/* Coverage before totals: a partial number must never be the first
                thing read without the sentence that says it is partial. */}
            {summary && (
              <p className={`portfolio-aggregate__coverage ${summary.complete ? "" : "is-partial"}`}>
                {summary.complete
                  ? `Complete: every one of the ${summary.networks} enabled network${summary.networks === 1 ? "" : "s"} answered. ${summary.totals.holdings} holding${summary.totals.holdings === 1 ? "" : "s"}.`
                  : `Partial: ${missing.length} of ${summary.networks} network${summary.networks === 1 ? "" : "s"} did not answer, so this total is a floor, not a complete portfolio.`}
              </p>
            )}

            {missing.length > 0 && (
              <ul className="portfolio-missing" aria-label="Networks that did not answer">
                {missing.map((entry) => (
                  <li key={entry.network}>
                    <strong>{entry.networkName}</strong>
                    <span>{entry.reason}</span>
                  </li>
                ))}
              </ul>
            )}

            {summary && summary.totals.byAsset.length > 0 ? (
              <dl className="portfolio-totals">
                {summary.totals.byAsset.map(({ symbol, amount, decimals }) => (
                  <div key={`${symbol}-${decimals}`}>
                    <dt>{symbol}</dt>
                    <dd>{amount}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="portfolio-aggregate__empty">
                {phase === "loading" ? "Waiting for the first network…" : "No positive balance was read on the networks that answered."}
              </p>
            )}

            {walletAddress && (
              <p className="portfolio-aggregate__wallet">ADDRESS {walletAddress}{readAt ? ` · READ ${readAt}` : ""}</p>
            )}
            {error && <p className="portfolio-aggregate__error" role="status">{error}</p>}
          </div>

          <ul className="portfolio-networks">
            {announced.length === 0 && phase === "loading" && (
              <li className="portfolio-network portfolio-network--pending" role="status">Discovering enabled networks…</li>
            )}
            {orderedNetworks.map((network) => (
              <NetworkRow
                announced={network}
                key={network.chainId}
                row={rows[networkKey(network.network)]}
                walletAddress={walletAddress}
              />
            ))}
          </ul>

          {announced.length === 0 && phase !== "loading" && (
            <p className="portfolio-aggregate__empty">
              No EVM mainnet is enabled for this account. Add one below to read it.
            </p>
          )}

          <details
            className="portfolio-settings"
            onToggle={(event) => setSettingsOpen(event.currentTarget.open)}
            open={settingsOpen}
          >
            <summary>Networks and token allow-list</summary>
            <p>
              The allow-list decides which tokens are <em>marked</em> as known — never which tokens are shown.
              Everything with a balance is listed, including contracts you have not added.
            </p>

            <div className="portfolio-settings__group">
              <div className="portfolio-settings__heading">
                <strong>Enabled networks</strong>
                <span>{additionalCount}/{MAX_ADDITIONAL_EVM_MAINNETS} ADDITIONAL</span>
              </div>
              <ul className="ethereum-network-list" aria-label="Enabled EVM mainnets">
                {announced.map((network) => (
                  <li key={network.chainId}>
                    <div className="ethereum-network-list__details">
                      <strong>{network.networkName}</strong>
                      <small>CHAIN {network.chainId}</small>
                    </div>
                    {network.chainId !== DEFAULT_EVM_MAINNET_CHAIN_ID && (
                      <button
                        aria-label={`Disable ${network.networkName}`}
                        className="portfolio-settings__icon"
                        disabled={settingsDisabled}
                        onClick={() => void removeNetwork(network.chainId)}
                        title="Disable network and remove its token list"
                        type="button"
                      >
                        <Trash2 aria-hidden="true" size={13} />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
              <form className="ethereum-network-form" onSubmit={addNetwork}>
                <select
                  aria-label="Network to enable"
                  disabled={settingsDisabled || addableNetworks.length === 0}
                  onChange={(event) => setNetworkToAdd(event.target.value)}
                  value={networkToAdd}
                >
                  <option value="">Add a mainnet…</option>
                  {addableNetworks.map((network) => (
                    <option key={network.chainId} value={network.chainId}>{network.name}</option>
                  ))}
                </select>
                <button disabled={settingsDisabled || !networkToAdd} type="submit">
                  <Plus aria-hidden="true" size={13} /> ENABLE
                </button>
              </form>
            </div>

            <div className="portfolio-settings__group">
              <div className="portfolio-settings__heading">
                <strong>Allow-listed contracts</strong>
                <span>{activeTokenContracts.length} LISTED</span>
              </div>
              <form className="ethereum-token-form" onSubmit={addContract}>
                <select
                  aria-label="Network for the token"
                  disabled={settingsDisabled}
                  onChange={(event) => setTokenChainId(Number(event.target.value))}
                  value={activeTokenChainId}
                >
                  {tokenNetworks.map((network) => (
                    <option key={network.chainId} value={network.chainId}>{network.networkName}</option>
                  ))}
                </select>
                <input
                  aria-label="Token contract address"
                  disabled={settingsDisabled}
                  onChange={(event) => setTokenAddress(event.target.value)}
                  placeholder="0x… contract address"
                  value={tokenAddress}
                />
                <button disabled={settingsDisabled || !tokenAddress.trim()} type="submit">
                  <Plus aria-hidden="true" size={13} /> ADD
                </button>
              </form>
              <ul className="ethereum-token-list" aria-label="Allow-listed contracts">
                {activeTokenContracts.length === 0 && <li className="ethereum-token-empty">No contract is allow-listed on this network. Tokens are still listed when balances exist.</li>}
                {activeTokenContracts.map((entry) => (
                  <li key={`${entry.chainId}-${entry.contractAddress}`}>
                    <code>{entry.contractAddress}</code>
                    <button
                      aria-label={`Remove ${entry.contractAddress} from the allow-list`}
                      disabled={settingsDisabled}
                      onClick={() => void removeContract(entry.chainId, entry.contractAddress)}
                      title="Remove from allow-list"
                      type="button"
                    >
                      <Trash2 aria-hidden="true" size={13} />
                    </button>
                  </li>
                ))}
              </ul>
            </div>

            {settingsError && <p className="portfolio-aggregate__error" role="status">{settingsError}</p>}
          </details>

          <div className="portfolio-footnote">
            <span>{summary?.complete ? "ALL ENABLED NETWORKS ANSWERED" : phase === "loading" ? "READING" : "PARTIAL READ — MISSING NETWORKS NAMED ABOVE"}</span>
            <button className="portfolio-refresh" disabled={phase === "loading"} onClick={() => reload()} type="button">
              <RefreshCw aria-hidden="true" size={11} /> RELOAD
            </button>
          </div>
        </>
      )}
    </section>
  );
}
