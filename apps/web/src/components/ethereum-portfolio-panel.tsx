"use client";

import { Plus, Trash2, Wallet } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import {
  isChecksummedAddress,
  MAX_ETHEREUM_TOKEN_ALLOWLIST_SIZE,
  normalizeChecksummedAddress,
} from "@/lib/portfolio/ethereum-token-allowlist";
import {
  DEFAULT_EVM_MAINNET_CHAIN_ID,
  EVM_MAINNETS,
  MAX_ADDITIONAL_EVM_MAINNETS,
} from "@/lib/portfolio/evm-mainnets";

type TokenBalance = {
  contractAddress: string;
  status: "available" | "unavailable";
  balance: string | null;
};

type NetworkBalance = {
  chainId: number;
  name: string;
  alchemyNetwork: string;
  nativeSymbol: string;
  contracts: string[];
  status: "available" | "not-connected" | "unavailable";
  nativeBalance: string | null;
  tokens: TokenBalance[];
};

type PortfolioResponse = {
  status: "available" | "not-connected" | "unavailable" | "unauthenticated";
  authenticated?: boolean;
  allowlistAvailable?: boolean;
  message?: string;
  walletAddress?: string;
  networks?: NetworkBalance[];
};

const initialState: PortfolioResponse = {
  status: "unavailable",
  authenticated: false,
  message: "Checking wallet balance connection.",
  networks: [],
};

/**
 * The server's own words when it refused, so a missing configuration name
 * ("Authentication is not configured: …", "ALCHEMY_API_KEY is not configured")
 * reaches the panel instead of a generic sentence.
 */
function serverReason(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  for (const key of ["message", "error"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

async function fetchPortfolio(): Promise<PortfolioResponse> {
  try {
    const response = await fetch("/api/portfolio/ethereum", {
      cache: "no-store",
      credentials: "same-origin",
    });
    const body: unknown = await response.json();
    if (response.status === 401) {
      return { status: "unauthenticated", authenticated: false, allowlistAvailable: false, message: "Connect a verified Ethereum mainnet wallet to manage this list.", networks: [] };
    }
    if (typeof body === "object" && body !== null && "status" in body &&
      ["available", "not-connected", "unavailable"].includes(String(body.status))) {
      return body as PortfolioResponse;
    }
    return { status: "unavailable", authenticated: false, allowlistAvailable: false, message: serverReason(body) ?? "Wallet portfolio is unavailable.", networks: [] };
  } catch (cause) {
    return {
      status: "unavailable",
      authenticated: false,
      allowlistAvailable: false,
      message: cause instanceof Error ? `Wallet portfolio could not be requested: ${cause.message}` : "Wallet portfolio is unavailable.",
      networks: [],
    };
  }
}

export function EthereumPortfolioPanel() {
  const [portfolio, setPortfolio] = useState(initialState);
  const [addressInput, setAddressInput] = useState("");
  const [networkToAdd, setNetworkToAdd] = useState("");
  const [tokenNetworkChainId, setTokenNetworkChainId] = useState(DEFAULT_EVM_MAINNET_CHAIN_ID);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchPortfolio().then((result) => {
      if (!cancelled) setPortfolio(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function refreshPortfolio() {
    setPortfolio(await fetchPortfolio());
  }

  async function changeNetwork(chainId: number, method: "POST" | "DELETE") {
    setError(null);
    setBusyKey(String(chainId));
    try {
      const response = await fetch("/api/portfolio/networks", {
        method,
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chainId }),
      });
      const result: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const reason = result && typeof result === "object" && "error" in result && typeof result.error === "string"
          ? result.error
          : "Network selection could not be saved.";
        throw new Error(reason);
      }
      setNetworkToAdd("");
      await refreshPortfolio();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Network selection could not be saved.");
    } finally {
      setBusyKey(null);
    }
  }

  async function addContract(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const contractAddress = normalizeChecksummedAddress(addressInput.trim());
    if (!contractAddress || !isChecksummedAddress(contractAddress)) {
      setError("Enter a valid EVM contract address; it will be saved in checksum form.");
      return;
    }
    setSaving(true);
    try {
      const response = await fetch("/api/portfolio/ethereum/tokens", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chainId: tokenChainId, contractAddress }),
      });
      const result: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const reason = result && typeof result === "object" && "error" in result && typeof result.error === "string"
          ? result.error
          : "Token contract could not be added.";
        throw new Error(reason);
      }
      setAddressInput("");
      await refreshPortfolio();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Token contract could not be added.");
    } finally {
      setSaving(false);
    }
  }

  async function removeContract(chainId: number, contractAddress: string) {
    setError(null);
    setBusyKey(`${chainId}:${contractAddress}`);
    try {
      const response = await fetch("/api/portfolio/ethereum/tokens", {
        method: "DELETE",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chainId, contractAddress }),
      });
      const result: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const reason = result && typeof result === "object" && "error" in result && typeof result.error === "string"
          ? result.error
          : "Token contract could not be removed.";
        throw new Error(reason);
      }
      await refreshPortfolio();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Token contract could not be removed.");
    } finally {
      setBusyKey(null);
    }
  }

  const networks = portfolio.networks ?? [];
  const enabledChainIds = new Set(networks.map(({ chainId }) => chainId));
  const availableNetworks = EVM_MAINNETS.filter(({ chainId }) => !enabledChainIds.has(chainId));
  const selectedTokenNetwork = networks.find(({ chainId }) => chainId === tokenNetworkChainId) ?? networks[0];
  const tokenChainId = selectedTokenNetwork?.chainId ?? DEFAULT_EVM_MAINNET_CHAIN_ID;
  const tokenContracts = networks.find(({ chainId }) => chainId === tokenChainId)?.contracts ?? [];
  const additionalNetworkCount = networks.filter(({ chainId }) => chainId !== DEFAULT_EVM_MAINNET_CHAIN_ID).length;
  const allowlistDisabled = portfolio.authenticated !== true || portfolio.allowlistAvailable !== true || saving || busyKey !== null;

  return (
    <section className="data-section portfolio-section" id="portfolio" aria-labelledby="portfolio-title">
      <div className="section-heading">
        <div>
          <div className="section-kicker">02 / EVM MAINNETS</div>
          <h2 id="portfolio-title">Portfolio</h2>
        </div>
        <span className="section-state">{portfolio.status === "available" ? "VERIFIED READS" : "NOT CONNECTED"}</span>
      </div>

      {portfolio.status !== "available" && (
        <div className="portfolio-empty" role="status">
          <div className="portfolio-glyph" aria-hidden="true"><Wallet size={20} strokeWidth={1.5} /></div>
          <strong>{portfolio.message ?? "Wallet balances are unavailable."}</strong>
          <p>Only selected EVM mainnet reads are shown. No balance is inferred.</p>
        </div>
      )}

      {portfolio.walletAddress && (
        <dl className="ethereum-balance-list">
          <div><dt>CONNECTED ADDRESS</dt><dd>{portfolio.walletAddress}</dd></div>
        </dl>
      )}

      <div className="ethereum-network-allowlist" aria-labelledby="ethereum-network-title">
        <div className="ethereum-token-allowlist__heading">
          <div>
            <div className="section-kicker">NETWORK ALLOW-LIST · MAINNET ONLY</div>
            <h3 id="ethereum-network-title">Enabled networks</h3>
          </div>
          <span>{additionalNetworkCount}/{MAX_ADDITIONAL_EVM_MAINNETS} ADDITIONAL</span>
        </div>
        <p>Ethereum is the default. Each added network is enabled only for this account.</p>
        {networks.length > 0 ? (
          <ul className="ethereum-network-list" aria-label="Enabled EVM mainnets">
            {networks.map((network) => (
              <li key={network.chainId}>
                <div className="ethereum-network-list__details">
                  <strong>{network.name}</strong>
                  <small>CHAIN {network.chainId} · {network.status === "available" ? `${network.nativeBalance} ${network.nativeSymbol}` : network.status === "not-connected" ? "NOT CONNECTED · ALCHEMY_API_KEY NOT SET" : "BALANCE UNAVAILABLE"}</small>
                </div>
                {network.chainId !== DEFAULT_EVM_MAINNET_CHAIN_ID && (
                  <button
                    aria-label={`Disable ${network.name}`}
                    disabled={allowlistDisabled}
                    onClick={() => void changeNetwork(network.chainId, "DELETE")}
                    title="Disable network and remove its token list"
                    type="button"
                  >
                    <Trash2 aria-hidden="true" size={14} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="ethereum-token-empty">Sign in to view this account&apos;s network allow-list.</p>
        )}
        <form className="ethereum-network-form" onSubmit={(event) => {
          event.preventDefault();
          if (networkToAdd) void changeNetwork(Number(networkToAdd), "POST");
        }}>
          <label className="sr-only" htmlFor="portfolio-network">Add a mainnet</label>
          <select
            disabled={allowlistDisabled || availableNetworks.length === 0 || additionalNetworkCount >= MAX_ADDITIONAL_EVM_MAINNETS}
            id="portfolio-network"
            onChange={(event) => setNetworkToAdd(event.target.value)}
            value={networkToAdd}
          >
            <option value="">Choose a supported mainnet</option>
            {availableNetworks.map((network) => <option key={network.chainId} value={network.chainId}>{network.name}</option>)}
          </select>
          <button disabled={allowlistDisabled || !networkToAdd || additionalNetworkCount >= MAX_ADDITIONAL_EVM_MAINNETS} type="submit">
            <Plus aria-hidden="true" size={14} />
            ENABLE NETWORK
          </button>
        </form>
      </div>

      <div className="ethereum-token-allowlist" aria-labelledby="ethereum-allowlist-title">
        <div className="ethereum-token-allowlist__heading">
          <div>
            <div className="section-kicker">ERC-20 TOKEN CONTRACTS</div>
            <h3 id="ethereum-allowlist-title">User-managed allow-list</h3>
          </div>
          <span>{tokenContracts.length}/{MAX_ETHEREUM_TOKEN_ALLOWLIST_SIZE} · {selectedTokenNetwork?.name ?? "NO NETWORK"}</span>
        </div>
        <p>Only checksum-valid contracts on an enabled network are queried. Empty list means native coin only.</p>
        <form className="ethereum-token-form" onSubmit={addContract}>
          <label className="sr-only" htmlFor="ethereum-token-network">Network for ERC-20 contract</label>
          <select
            disabled={allowlistDisabled || networks.length === 0}
            id="ethereum-token-network"
            onChange={(event) => setTokenNetworkChainId(Number(event.target.value))}
            value={tokenChainId}
          >
            {networks.map((network) => <option key={network.chainId} value={network.chainId}>{network.name}</option>)}
          </select>
          <label className="sr-only" htmlFor="ethereum-token-address">Checksummed EVM token contract address</label>
          <input
            autoComplete="off"
            disabled={allowlistDisabled || tokenContracts.length >= MAX_ETHEREUM_TOKEN_ALLOWLIST_SIZE || networks.length === 0}
            id="ethereum-token-address"
            inputMode="text"
            onChange={(event) => setAddressInput(event.target.value)}
            placeholder="0x checksummed contract address"
            spellCheck={false}
            value={addressInput}
          />
          <button disabled={allowlistDisabled || tokenContracts.length >= MAX_ETHEREUM_TOKEN_ALLOWLIST_SIZE || networks.length === 0 || !addressInput.trim()} type="submit">
            <Plus aria-hidden="true" size={14} />
            ADD CONTRACT
          </button>
        </form>
        {tokenContracts.length > 0 ? (
          <ul className="ethereum-token-list" aria-label="Allow-listed ERC-20 contracts">
            {tokenContracts.map((contractAddress) => (
              <li key={`${tokenChainId}:${contractAddress}`}>
                <code>{contractAddress}</code>
                <button
                  aria-label={`Remove ${contractAddress} from token allow-list`}
                  disabled={allowlistDisabled}
                  onClick={() => void removeContract(tokenChainId, contractAddress)}
                  title="Remove contract"
                  type="button"
                >
                  <Trash2 aria-hidden="true" size={14} />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="ethereum-token-empty">No token contracts added.</p>
        )}
        {error && <p className="login-error" role="alert">{error}</p>}
      </div>

      <div className="portfolio-footnote">
        <span>TRADING FUNDS</span>
        <strong>Not connected · balance reads do not authorize orders</strong>
      </div>
    </section>
  );
}