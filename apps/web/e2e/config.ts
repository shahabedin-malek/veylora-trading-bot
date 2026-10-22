/**
 * Everything the browser suite and the local server must agree about.
 *
 * One module because a disagreement here is the failure the suite exists to
 * catch: the server would be configured for one chain, one token or one owner
 * while the spec signs in as another. The values are deliberately local and
 * disposable — a public test key, a public BIP-39 test vector, a mock chain and
 * a SQLite file — so nothing here can touch a real account.
 */
import { privateKeyToAccount } from "viem/accounts";

export const E2E_PORT = Number(process.env.E2E_PORT ?? 3370);
export const E2E_BASE_URL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${E2E_PORT}`;

/** The mock JSON-RPC endpoint Next calls; HTTPS because the RPC resolver refuses http. */
export const E2E_RPC_PORT = Number(process.env.E2E_RPC_PORT ?? 3471);
/** The plain-HTTP control surface the spec uses to place a transfer on the mock chain. */
export const E2E_CONTROL_PORT = Number(process.env.E2E_CONTROL_PORT ?? 3472);
export const E2E_CONTROL_URL = process.env.E2E_CONTROL_URL ?? `http://127.0.0.1:${E2E_CONTROL_PORT}`;

// Chain 1 on purpose: the seed writes the owner's wallet identity for chain 1, so
// signing in on chain 1 is what proves the seeded OWNER keeps its permissions. The
// endpoint behind it is the loopback mock, never a real mainnet.
export const E2E_CHAIN_ID = 1;
export const E2E_CHAIN_ID_HEX = "0x1";
export const E2E_NETWORK_SLUG = "ethereum-mainnet";
export const E2E_NETWORK_LABEL = "Ethereum";

export const E2E_TOKEN = {
  symbol: "USDT",
  address: "0x00000000000000000000000000000000000000aa",
  decimals: 6,
} as const;

/** A second ERC-20, deliberately not the deposit token: the unmatched-token failure path. */
export const E2E_WRONG_TOKEN = {
  symbol: "SCAM",
  address: "0x00000000000000000000000000000000000000bb",
  decimals: 6,
} as const;

export const E2E_WITHDRAWAL_DESTINATION = "0x3333333333333333333333333333333333333333";

/**
 * Public Hardhat accounts. They are test vectors, not credentials: the keys are
 * published in every Hardhat install and are funded nowhere. The first one is
 * the seeded OWNER so the admin failure paths have the permissions they need.
 */
export const E2E_OWNER = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
export const E2E_DEPOSITOR = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
export const E2E_WITHDRAWER = privateKeyToAccount("0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6");

/** Public BIP-39 test vectors. Deposit addresses and the simulated sender derive from these. */
export const E2E_DEPOSIT_MNEMONIC = "test test test test test test test test test test test junk";
export const E2E_HOT_WALLET_MNEMONIC = "legal winner thank year wave sausage worth useful legal winner thank yellow";

export const E2E_SESSION_SECRET = "e2e-only-session-secret-0123456789abcdef";
export const E2E_CRON_SECRET = "e2e-only-cron-secret-0123456789abcdef";

/** The environment the Next process, the seed and the teardown all share. */
export function e2eEnvironment(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...extra,
    NODE_ENV: "development",
    // The fixture runner is a separate process: without this it would read the
    // schema's `env("DATABASE_URL")` and fail before the server starts.
    DATABASE_URL: "file:./dev.db",
    APP_BASE_URL: E2E_BASE_URL,
    AUTH_EVM_CHAIN_IDS: String(E2E_CHAIN_ID),
    SESSION_SECRET: E2E_SESSION_SECRET,
    INITIAL_ADMIN_EVM_ADDRESS: E2E_OWNER.address,
    CRON_SECRET: E2E_CRON_SECRET,
    NEXT_TELEMETRY_DISABLED: "1",
    DEPOSIT_ADDRESS_MNEMONIC: E2E_DEPOSIT_MNEMONIC,
    DEPOSIT_ENABLED_NETWORKS: E2E_NETWORK_SLUG,
    DEPOSIT_TOKEN_ADDRESS_ETHEREUM_MAINNET: E2E_TOKEN.address,
    DEPOSIT_TOKEN_DECIMALS_ETHEREUM_MAINNET: String(E2E_TOKEN.decimals),
    DEPOSIT_TOKEN_SYMBOL_ETHEREUM_MAINNET: E2E_TOKEN.symbol,
    DEPOSIT_CONFIRMATIONS_ETHEREUM_MAINNET: "1",
    DEPOSIT_MIN_AMOUNT_ETHEREUM_MAINNET: "1",
    ALCHEMY_ETHEREUM_MAINNET_RPC_URL: `https://127.0.0.1:${E2E_RPC_PORT}/rpc`,
    WITHDRAWAL_HOT_WALLET_MNEMONIC: E2E_HOT_WALLET_MNEMONIC,
    WITHDRAWAL_HOT_WALLET_INDEX: "0",
    WITHDRAWAL_NEW_ADDRESS_WINDOW_MINUTES: "0",
    WITHDRAWAL_BROADCAST_MODE: "simulated",
    WITHDRAWAL_REQUEST_EXPIRY_MINUTES: "60",
    WITHDRAWAL_CANCEL_AFTER_MINUTES: "60",
  };
}
