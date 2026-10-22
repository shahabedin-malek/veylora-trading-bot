"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  EIP1193_ERROR_CODES,
  parseChainId,
  providerErrorCode,
  readWalletChainId,
  switchWalletChain,
  type Eip1193Provider,
} from "@/lib/auth/eip1193";
import type { NetworkHealthRecord } from "@/lib/rpc/health";
import { reconcileNetworkSelection, selectionProblem, switchNotice } from "@/lib/rpc/selection";
import type { NetworkRegistryEntry } from "@/lib/rpc/networks";

const STORAGE_KEY = "veylora.network";

type RegistryResponse = {
  readAt: string;
  networks: NetworkRegistryEntry[];
  totals: { discovered: number; available: number; unavailable: number; evm: number; listedForPortfolio: number };
  ignoredVariables: string[];
  health: NetworkHealthRecord[];
};

type Probe = { chainId: number; blockNumber: number | null; latencyMs: number };

function injectedProvider(): Eip1193Provider | null {
  if (typeof window === "undefined") return null;
  const candidate = (window as unknown as { ethereum?: unknown }).ethereum;
  return candidate && typeof (candidate as Eip1193Provider).request === "function"
    ? (candidate as Eip1193Provider)
    : null;
}

async function rpcCall(slug: string, method: string): Promise<unknown> {
  const response = await fetch(`/api/rpc/${encodeURIComponent(slug)}`, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] }),
  });
  const body = await response.json().catch(() => null) as { result?: unknown; error?: string } | null;
  if (!response.ok) throw new Error(body?.error ?? `${slug} answered ${response.status}.`);
  return body?.result;
}

function optionLabel(entry: NetworkRegistryEntry): string {
  const chain = entry.chainId === null ? "no chain id" : `chain ${entry.chainId}`;
  return `${entry.name} · ${chain}${entry.availability === "unavailable" ? " — unavailable" : ""}`;
}

export function NetworkSwitcher() {
  const [registry, setRegistry] = useState<RegistryResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [walletChainId, setWalletChainId] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [probe, setProbe] = useState<Probe | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const registryRef = useRef<RegistryResponse | null>(null);

  const entries = useMemo(() => registry?.networks ?? [], [registry]);
  const selected = useMemo(
    () => entries.find(({ slug }) => slug === selectedSlug) ?? null,
    [entries, selectedSlug],
  );
  const health = useMemo(
    () => registry?.health.find((record) => record.slug === selected?.slug) ?? null,
    [registry, selected],
  );

  const remember = useCallback((slug: string | null) => {
    setSelectedSlug(slug);
    try {
      if (slug) localStorage.setItem(STORAGE_KEY, slug);
      else localStorage.removeItem(STORAGE_KEY);
    } catch {
      // A browser that refuses storage still gets a working selection for this page.
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/portfolio/networks", { cache: "no-store", credentials: "same-origin" });
        const body: unknown = await response.json().catch(() => null);
        if (!response.ok || typeof body !== "object" || body === null || !("networks" in body)) {
          const reason = body && typeof body === "object" && "error" in body && typeof body.error === "string"
            ? body.error
            : `The network registry could not be read (${response.status}).`;
          throw new Error(reason);
        }
        if (cancelled) return;
        const next = body as RegistryResponse;
        registryRef.current = next;
        setRegistry(next);

        const provider = injectedProvider();
        const chainId = provider ? await readWalletChainId(provider).catch(() => null) : null;
        if (cancelled) return;
        setWalletChainId(chainId);

        let stored: string | null = null;
        try {
          stored = localStorage.getItem(STORAGE_KEY);
        } catch {
          stored = null;
        }
        const selection = reconcileNetworkSelection({
          entries: next.networks,
          storedSlug: stored,
          walletChainId: chainId,
        });
        setSelectedSlug(selection.slug);
        setNotice(selection.notice);
        if (selection.slug) {
          try {
            localStorage.setItem(STORAGE_KEY, selection.slug);
          } catch {
            // Same as above: the page works without storage.
          }
        }
      } catch (cause) {
        if (!cancelled) setLoadError(cause instanceof Error ? cause.message : "The network registry could not be read.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // The wallet is the side that can change without this page acting, so its
  // chain change is reconciled into the selection rather than ignored.
  useEffect(() => {
    const provider = injectedProvider();
    if (!provider?.on || !registry) return;
    const onChainChanged = (value: unknown) => {
      const chainId = parseChainId(value);
      if (chainId === null) return;
      setWalletChainId(chainId);
      let stored: string | null = null;
      try {
        stored = localStorage.getItem(STORAGE_KEY);
      } catch {
        stored = null;
      }
      const selection = reconcileNetworkSelection({
        entries: registryRef.current?.networks ?? [],
        storedSlug: stored,
        walletChainId: chainId,
      });
      setSelectedSlug(selection.slug);
      setNotice(selection.notice);
    };
    provider.on("chainChanged", onChainChanged);
    return () => provider.removeListener?.("chainChanged", onChainChanged);
  }, [registry]);

  const probeNetwork = useCallback(async (entry: NetworkRegistryEntry) => {
    if (entry.availability === "unavailable") return;
    const startedAt = performance.now();
    const chainIdHex = await rpcCall(entry.slug, "eth_chainId");
    const blockHex = await rpcCall(entry.slug, "eth_blockNumber");
    const chainId = parseChainId(chainIdHex);
    if (chainId === null) throw new Error(`${entry.name} did not report a chain id.`);
    if (entry.chainId !== null && chainId !== entry.chainId) {
      throw new Error(
        `${entry.name} answered chain ${chainId}, but the registry says chain ${entry.chainId}. ` +
        `${entry.variable} may point at a different network, so the selection is not trusted.`,
      );
    }
    const block = typeof blockHex === "string" && /^0x[0-9a-f]+$/i.test(blockHex) ? Number.parseInt(blockHex, 16) : NaN;
    setProbe({
      chainId,
      blockNumber: Number.isSafeInteger(block) ? block : null,
      latencyMs: Math.round(performance.now() - startedAt),
    });
  }, []);

  const moveWallet = useCallback(async (entry: NetworkRegistryEntry) => {
    const problem = selectionProblem(entry);
    if (problem) {
      setNotice(problem);
      return;
    }
    const provider = injectedProvider();
    if (!provider) {
      setNotice(`No injected wallet is available in this browser, so ${entry.name} cannot be requested. The selection is remembered and its RPC endpoint still works.`);
      return;
    }
    setBusy(true);
    try {
      const { reachedChainId } = await switchWalletChain(provider, entry.chainId!);
      setWalletChainId(reachedChainId);
      setNotice(switchNotice({ requestedChainId: entry.chainId!, reachedChainId, name: entry.name }));
    } catch (cause) {
      const code = providerErrorCode(cause);
      setNotice(
        code === EIP1193_ERROR_CODES.UNRECOGNIZED_CHAIN
          ? `The wallet does not know ${entry.name} (chain ${entry.chainId}). Add that network in the wallet, then retry.`
          : code === EIP1193_ERROR_CODES.USER_REJECTED
            ? "The wallet request was cancelled. The selection is remembered, but the wallet did not move."
            : `The wallet could not switch to ${entry.name}. Open the wallet and switch to chain ${entry.chainId}, then retry.`,
      );
    } finally {
      setBusy(false);
    }
  }, []);

  async function selectNetwork(slug: string) {
    const entry = entries.find((candidate) => candidate.slug === slug) ?? null;
    setProbe(null);
    setProbeError(null);
    setNotice(null);
    if (!entry) return;
    remember(entry.slug);

    // An unavailable network already states its reason in the facts block; a
    // second copy in the notice would say the same sentence twice.
    if (entry.availability === "unavailable") return;

    const problem = selectionProblem(entry);
    if (problem) {
      setNotice(problem);
      return;
    }
    try {
      await probeNetwork(entry);
    } catch (cause) {
      setProbeError(cause instanceof Error ? cause.message : `${entry.name} could not be verified.`);
      return;
    }
    await moveWallet(entry);
  }

  async function checkAgain() {
    if (!selected) return;
    setBusy(true);
    setProbeError(null);
    try {
      await probeNetwork(selected);
      const provider = injectedProvider();
      if (provider) setWalletChainId(await readWalletChainId(provider));
    } catch (cause) {
      setProbe(null);
      setProbeError(cause instanceof Error ? cause.message : `${selected.name} could not be verified.`);
    } finally {
      setBusy(false);
    }
  }

  const switchable = entries.filter((entry) => entry.kind === "evm" && entry.chainId !== null);
  const proxyOnly = entries.filter((entry) => entry.kind !== "evm" || entry.chainId === null);

  return (
    <section className="data-section network-switcher-section" aria-labelledby="network-switcher-title">
      <div className="section-heading">
        <div>
          <div className="section-kicker">00 / NETWORKS</div>
          <h2 id="network-switcher-title">Network registry</h2>
        </div>
        <span className="section-state">
          {registry ? `${registry.totals.available}/${registry.totals.discovered} AVAILABLE` : "READING ENVIRONMENT"}
        </span>
      </div>
      <p className="trading-security-note">
        Every declared network is discovered from <code>ALCHEMY_&lt;NETWORK&gt;_RPC_URL</code> or
        {" "}<code>ALCHEMY_&lt;NETWORK&gt;_API_KEY</code> at runtime — nothing here is a code list. Selecting a
        network verifies its RPC endpoint through this deployment&apos;s proxy, then moves the wallet to that chain
        and reads the wallet back to confirm it moved.
      </p>

      {loadError && <p className="login-error" role="alert">{loadError}</p>}

      {registry && (
        <>
          <form className="network-switcher-form" onSubmit={(event) => event.preventDefault()}>
            <label htmlFor="network-switcher-select">NETWORK</label>
            <select
              disabled={busy || entries.length === 0}
              id="network-switcher-select"
              onChange={(event) => void selectNetwork(event.target.value)}
              value={selectedSlug ?? ""}
            >
              {entries.length === 0 && <option value="">No network variable is configured</option>}
              {switchable.length > 0 && (
                <optgroup label="EVM networks (wallet-switchable)">
                  {switchable.map((entry) => <option key={entry.slug} value={entry.slug}>{optionLabel(entry)}</option>)}
                </optgroup>
              )}
              {proxyOnly.length > 0 && (
                <optgroup label="Non-EVM or no chain id (RPC proxy only)">
                  {proxyOnly.map((entry) => <option key={entry.slug} value={entry.slug}>{optionLabel(entry)}</option>)}
                </optgroup>
              )}
            </select>
            <div className="network-switcher-form__actions">
              <button disabled={busy || !selected} onClick={() => void checkAgain()} type="button">
                CHECK AGAIN
              </button>
              <button disabled={busy || !selected || selectionProblem(selected) !== null} onClick={() => selected && void moveWallet(selected)} type="button">
                SWITCH WALLET
              </button>
            </div>
          </form>

          {selected && (
            <dl className="market-source-details network-switcher-facts">
              <div><dt>CHAIN ID</dt><dd>{selected.chainId ?? "UNKNOWN"}</dd></div>
              <div><dt>NATIVE ASSET</dt><dd>{selected.nativeSymbol ?? "UNKNOWN"}</dd></div>
              <div><dt>KIND</dt><dd>{selected.kind.toUpperCase()}</dd></div>
              <div><dt>TESTNET</dt><dd>{selected.testnet ? "YES" : "NO"}</dd></div>
              <div><dt>TOKEN ALLOW-LIST</dt><dd>{selected.tokenAllowlist.replaceAll("-", " ").toUpperCase()}</dd></div>
              <div><dt>CONFIGURED BY</dt><dd>{selected.source.replaceAll("-", " ").toUpperCase()}</dd></div>
              <div><dt>WALLET CHAIN</dt><dd>{walletChainId ?? "NO INJECTED WALLET"}</dd></div>
              <div><dt>HEALTH AT LOAD</dt><dd>{health ? `${health.consecutiveFailures} FAILURE(S) · ${health.lastLatencyMs ?? "—"} MS` : "NO CALL RECORDED"}</dd></div>
            </dl>
          )}

          {selected?.explorerUrl && (
            <p className="network-switcher-explorer">
              <a href={selected.explorerUrl} rel="noreferrer" target="_blank">Open {selected.name} explorer</a>
            </p>
          )}

          {selected?.availability === "unavailable" && selected.reason && (
            <p className="network-switcher-notice" role="status">{selected.reason}</p>
          )}
          {notice && <p className="network-switcher-notice" role="status">{notice}</p>}
          {probeError && <p className="login-error" role="alert">{probeError}</p>}
          {probe && (
            <p className="network-switcher-verified" role="status">
              VERIFIED · chain {probe.chainId}
              {probe.blockNumber === null ? "" : ` · block ${probe.blockNumber.toLocaleString("en-US")}`}
              {` · ${probe.latencyMs} ms round trip`}
            </p>
          )}

          <p className="network-switcher-footnote">
            {registry.totals.evm} EVM · {registry.totals.listedForPortfolio} in the portfolio token allow-list ·{" "}
            {registry.totals.unavailable} unavailable
            {registry.ignoredVariables.length > 0 ? ` · ${registry.ignoredVariables.length} beacon endpoint(s) ignored` : ""}
            {" · "}read {registry.readAt.slice(11, 19)} UTC
          </p>
        </>
      )}
    </section>
  );
}
