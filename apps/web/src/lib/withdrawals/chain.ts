import { encodeFunctionData, keccak256, type Address, type Hex } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { instrumentFetch, PROVIDER_IDS } from "@/lib/observability/provider-call";
import { reason, type Reason } from "@/lib/observability/reason";
import { resolveRpcEndpoint, rpcConfigurationVariableName } from "@/lib/rpc/networks";
import { WITHDRAWAL_HOT_WALLET_MNEMONIC_VARIABLE, type WithdrawalNetworkPolicy, type WithdrawalPolicy } from "./policy";

/**
 * The port every sending wallet is reached through, and the two implementations.
 *
 * The withdrawal path never talks to a chain directly. It asks this port three
 * questions, and the same three are all a real chain and a development simulation have
 * in common:
 *
 *  - **`sender`** — where would this network be sent from? A refusal here is
 *    configuration (`NETWORK_UNSUPPORTED`), not a failed transfer.
 *  - **`prepare`** — sign the transfer *without* sending it. The signed bytes are a
 *    return value rather than a side effect, which is the whole mechanism behind "a
 *    retry never broadcasts a second transaction": the bytes are stored on the
 *    withdrawal row before anything is sent, and a retry re-sends *those* bytes. A node
 *    deduplicates by transaction hash, so a re-send that lands twice is still one
 *    transaction — and a re-*sign* would not be, because the same transfer signed after
 *    a nonce moved is a different transaction with a different hash.
 *  - **`observe`** — what does the chain say about a hash now? Confirmations are counted
 *    from the head against the count the owner configured for the network, and the
 *    receipt's status is the difference between a transfer that happened and one that
 *    reverted.
 *
 * `confirmationsKnown` is passed into `observe` because a confirmation count is a fact
 * about the *chain* while "how many have I counted so far" is a fact about the row: the
 * real port ignores it and counts from the head, the simulation advances by a fixed step
 * per check, which is what makes a development confirmation arrive in a handful of
 * passes instead of twelve blocks.
 *
 * **The signed bytes are never logged and never returned to a browser.** They are a
 * signature over the owner's money; the row holds them so a retry can re-send them, and
 * the API resource renders the hash and nothing else.
 */

const REQUEST_TIMEOUT_MS = 15_000;

/** `transfer(address,uint256)` — the only call a withdrawal makes to a token. */
const ERC20_TRANSFER_ABI = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

/** The calldata for one ERC-20 transfer. Pure, so a test can decode it back. */
export function erc20TransferData(to: string, amountMinor: string): Hex {
  return encodeFunctionData({
    abi: ERC20_TRANSFER_ABI,
    functionName: "transfer",
    args: [to as Address, BigInt(amountMinor)],
  });
}

/** The gas a simulated transfer is signed with. Real transfers estimate theirs. */
export const SIMULATED_GAS_LIMIT = BigInt(65_000);
/** The price a simulated transfer is signed with, in wei. */
export const SIMULATED_GAS_PRICE_WEI = BigInt(1_000_000_000);

export type SenderOutcome = { kind: "ready"; address: string } | { kind: "unavailable"; reason: Reason };

export type PrepareInput = {
  network: WithdrawalNetworkPolicy;
  /** The destination, lowercased `0x…`. */
  to: string;
  /** What the token contract is asked to send. */
  netMinor: string;
  /** The withdrawal this signature belongs to, for the idempotency key of the send. */
  withdrawalId: string;
  /**
   * The nonce to sign with, when the caller already knows it — a retry signs the same
   * nonce again and a nonce conflict bumps it. Null reads the chain's pending count.
   */
  nonce?: number | null;
};

export type PreparedTransfer = {
  rawTransaction: string;
  txHash: string;
  nonce: number;
  fromAddress: string;
  /** What the chain was told, for the audit trail. Never a secret. */
  tokenAddress: string;
  netMinor: string;
  gasLimit: string;
  gasPriceWei: string;
};

export type PrepareOutcome = { kind: "signed"; transfer: PreparedTransfer } | { kind: "refused"; reason: Reason };

export type BroadcastOutcome = { kind: "accepted"; txHash: string } | { kind: "refused"; reason: Reason };

export type Observation =
  | { kind: "mined"; status: "success" | "reverted"; confirmations: number; blockNumber: number }
  | { kind: "pending"; confirmations: number }
  | { kind: "unknown"; reason: Reason };

export type WithdrawalChainPort = {
  id: string;
  /** True when this port moves no real money, so every surface says so. */
  simulated: boolean;
  sender(): SenderOutcome;
  prepare(input: PrepareInput): Promise<PrepareOutcome>;
  /**
   * Sign a *replacement* for a transfer that is already on chain at the same nonce.
   *
   * A cancellation on an account-based chain is not a withdrawal of anything: it is a
   * second transaction signed with the **same nonce** and a **higher fee**, which the
   * network will accept *instead of* the first — the first then can never be mined. The
   * replacement carries no value and no calldata, so the only thing it can do is take the
   * nonce, which is exactly what a cancellation is.
   *
   * It is a separate call from {@link prepare} because it is a different transaction with
   * a different purpose; folding it into `prepare` would mean the sending path could build
   * one by accident.
   */
  prepareCancel(input: PrepareCancelInput): Promise<PrepareOutcome>;
  broadcast(input: { rawTransaction: string }): Promise<BroadcastOutcome>;
  observe(input: { txHash: string; confirmationsKnown: number }): Promise<Observation>;
};

export type PrepareCancelInput = {
  network: WithdrawalNetworkPolicy;
  withdrawalId: string;
  /** The nonce the original transaction used, which the replacement must reuse. */
  nonce: number;
  /** The fee the original was signed with, in wei: the replacement must beat it. */
  aboveGasPriceWei: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// The signing wallet: one account of one seed, on every network.
// ─────────────────────────────────────────────────────────────────────────────

export type SignableTransaction = {
  chainId: number;
  nonce: number;
  to: string;
  data: Hex;
  gas: bigint;
  gasPrice: bigint;
};

export type SenderWallet =
  | { ok: true; address: string; signTransaction: (transaction: SignableTransaction) => Promise<Hex> }
  | { ok: false; reason: Reason };

/**
 * The sending wallet, derived from the seed the owner configured.
 *
 * One wallet for every network rather than one per chain, because a withdrawal route is
 * a *transfer* and not an account: the platform already holds the funds, and what it
 * needs is an address that can sign and pay gas. The derivation is the same BIP-44 shape
 * the deposit addresses use — `m/44'/60'/0'/0/<index>` — so a deployment can hold one
 * seed and know exactly which of its accounts spends. (The deposit addresses hash a
 * user id into that index space; this one is the owner's own number, which is why the
 * two never collide unless the owner chooses an index that is also a hash.)
 *
 * The private key is never returned: only an address and a signing function, so no
 * caller can render or store the key, and nothing above this file sees anything but
 * signed bytes.
 */
export function senderWallet(policy: WithdrawalPolicy): SenderWallet {
  if (!policy.hotWalletMnemonic) {
    return {
      ok: false,
      reason: reason("MISSING_CONFIGURATION", {
        variable: WITHDRAWAL_HOT_WALLET_MNEMONIC_VARIABLE,
        message: `${WITHDRAWAL_HOT_WALLET_MNEMONIC_VARIABLE} is not configured, so no withdrawal can be signed.`,
      }),
    };
  }
  try {
    const account = mnemonicToAccount(policy.hotWalletMnemonic, { addressIndex: policy.hotWalletIndex });
    return {
      ok: true,
      address: account.address,
      signTransaction: async (transaction) =>
        account.signTransaction({
          chainId: transaction.chainId,
          nonce: transaction.nonce,
          to: transaction.to as Address,
          value: BigInt(0),
          data: transaction.data,
          gas: transaction.gas,
          // Legacy pricing: one field, one RPC read, and valid on every chain this
          // deployment sends on. EIP-1559 pricing is an improvement, not a
          // requirement, and it belongs with phase 16's fee schedule.
          gasPrice: transaction.gasPrice,
          type: "legacy",
        }),
    };
  } catch (error) {
    return {
      ok: false,
      reason: reason("MISSING_CONFIGURATION", {
        variable: WITHDRAWAL_HOT_WALLET_MNEMONIC_VARIABLE,
        message:
          `${WITHDRAWAL_HOT_WALLET_MNEMONIC_VARIABLE} is set but no account could be derived from it: ` +
          `${error instanceof Error ? error.message : "unknown error"}.`,
      }),
    };
  }
}

/** The sending address for a network, or why there is none. Shared by both ports. */
export function resolveSender(policy: WithdrawalPolicy, network: WithdrawalNetworkPolicy, configured: boolean): SenderOutcome {
  if (!configured) {
    return {
      kind: "unavailable",
      reason: reason("NETWORK_UNSUPPORTED", {
        variable: rpcConfigurationVariableName(network.alchemyNetwork) ?? undefined,
        message: `${network.displayName} has no RPC endpoint configured, so nothing can be sent on it.`,
      }),
    };
  }
  const wallet = senderWallet(policy);
  return wallet.ok ? { kind: "ready", address: wallet.address } : { kind: "unavailable", reason: wallet.reason };
}

// ─────────────────────────────────────────────────────────────────────────────
// The real port: sign locally, send through the configured RPC.
// ─────────────────────────────────────────────────────────────────────────────

type RpcDeps = { fetch?: typeof fetch; env?: NodeJS.ProcessEnv };

type RpcAnswer = { ok: true; result: unknown } | { ok: false; reason: Reason };

async function rpcCall(endpoint: string, method: string, params: unknown[], fetcher: typeof fetch): Promise<RpcAnswer> {
  const request = instrumentFetch({ providerId: PROVIDER_IDS.alchemyRpc, fetcher });
  let response: Response;
  try {
    response = await request(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    return {
      ok: false,
      reason: reason("NETWORK_UNAVAILABLE", {
        providerId: PROVIDER_IDS.alchemyRpc,
        message: `The RPC endpoint did not answer ${method}: ${error instanceof Error ? error.message : "unknown error"}.`,
      }),
    };
  }
  if (!response.ok) {
    return {
      ok: false,
      reason: reason("NETWORK_UNAVAILABLE", {
        providerId: PROVIDER_IDS.alchemyRpc,
        message: `The RPC endpoint answered ${response.status} to ${method}.`,
      }),
    };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return {
      ok: false,
      reason: reason("NETWORK_UNAVAILABLE", {
        providerId: PROVIDER_IDS.alchemyRpc,
        message: `The RPC endpoint answered ${method} with a body that is not JSON.`,
      }),
    };
  }
  if (typeof body !== "object" || body === null) {
    return {
      ok: false,
      reason: reason("NETWORK_UNAVAILABLE", {
        providerId: PROVIDER_IDS.alchemyRpc,
        message: `The RPC endpoint answered ${method} with a shape this build cannot read.`,
      }),
    };
  }
  const record = body as { result?: unknown; error?: unknown };
  if (record.error) {
    const detail = JSON.stringify(record.error).slice(0, 300);
    // A refused call is the chain's own answer about this transfer: a nonce already
    // spent, an estimate that would revert, a fee under the floor. Each is a different
    // sentence, and `attempts` on the row records that it was tried.
    const text = detail.toLowerCase();
    const nonceTaken =
      text.includes("nonce") && (text.includes("too low") || text.includes("already") || text.includes("lower than"));
    return {
      ok: false,
      reason: nonceTaken
        ? reason("NONCE_CONFLICT", {
            providerId: PROVIDER_IDS.alchemyRpc,
            message: `The network refused ${method} because the nonce was already used: ${detail}`,
          })
        : reason("NETWORK_UNAVAILABLE", {
            providerId: PROVIDER_IDS.alchemyRpc,
            message: `The network refused ${method}: ${detail}`,
          }),
    };
  }
  return { ok: true, result: record.result };
}

function hexQuantity(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) return null;
  return BigInt(value);
}

export const ONCHAIN_CHAIN_ID = "alchemy-evm";

/**
 * A real port, bound to one network.
 *
 * Bound, rather than handed a network on every call, because two of its three calls
 * have to reach the *same* chain: a signature made for one chain and broadcast to
 * another is a transaction nobody can explain, and a port that took the network as an
 * argument would let that happen by moving an argument in one place. One withdrawal is
 * sent on one network, so the port is built for it.
 */
export function createOnchainWithdrawalChain(
  policy: WithdrawalPolicy,
  network: WithdrawalNetworkPolicy,
  deps: RpcDeps = {},
): WithdrawalChainPort {
  const env = deps.env ?? process.env;
  const fetcher = deps.fetch ?? fetch;
  const resolution = resolveRpcEndpoint(network.alchemyNetwork, env);
  const endpoint = resolution.ok ? resolution.endpoint : null;
  const unconfigured: Reason = reason("NETWORK_UNSUPPORTED", {
    variable: rpcConfigurationVariableName(network.alchemyNetwork) ?? undefined,
    message: `${network.displayName} has no RPC endpoint configured, so nothing can be sent on it.`,
  });

  return {
    id: `${ONCHAIN_CHAIN_ID}:${network.slug}`,
    simulated: false,

    sender() {
      return resolveSender(policy, network, endpoint !== null);
    },

    async prepare(input) {
      if (!endpoint) return { kind: "refused", reason: unconfigured };
      const wallet = senderWallet(policy);
      if (!wallet.ok) return { kind: "refused", reason: wallet.reason };

      const data = erc20TransferData(input.to, input.netMinor);

      let nonce = input.nonce ?? null;
      if (nonce === null) {
        const answer = await rpcCall(endpoint, "eth_getTransactionCount", [wallet.address, "pending"], fetcher);
        if (!answer.ok) return { kind: "refused", reason: answer.reason };
        const parsed = hexQuantity(answer.result);
        if (parsed === null) {
          return {
            kind: "refused",
            reason: reason("NETWORK_UNAVAILABLE", {
              providerId: PROVIDER_IDS.alchemyRpc,
              message: "The network did not answer with a usable transaction count, so nothing was signed.",
            }),
          };
        }
        nonce = Number(parsed);
      }

      const estimate = await rpcCall(
        endpoint,
        "eth_estimateGas",
        [{ from: wallet.address, to: network.token.address, data }],
        fetcher,
      );
      if (!estimate.ok) return { kind: "refused", reason: estimate.reason };
      const estimated = hexQuantity(estimate.result);
      if (estimated === null) {
        return {
          kind: "refused",
          reason: reason("NETWORK_UNAVAILABLE", {
            providerId: PROVIDER_IDS.alchemyRpc,
            message: "The network did not answer with a usable gas estimate, so nothing was signed.",
          }),
        };
      }
      // A margin over the estimate: an ERC-20 transfer into a token that has never seen
      // this recipient costs more than the estimate on some chains, and a transfer that
      // runs out of gas is a reverted transaction and a wasted fee.
      const gas = (estimated * BigInt(12)) / BigInt(10) + BigInt(21_000);

      const price = await rpcCall(endpoint, "eth_gasPrice", [], fetcher);
      if (!price.ok) return { kind: "refused", reason: price.reason };
      const gasPrice = hexQuantity(price.result);
      if (gasPrice === null) {
        return {
          kind: "refused",
          reason: reason("NETWORK_UNAVAILABLE", {
            providerId: PROVIDER_IDS.alchemyRpc,
            message: "The network did not answer with a usable gas price, so nothing was signed.",
          }),
        };
      }

      let rawTransaction: Hex;
      try {
        rawTransaction = await wallet.signTransaction({
          chainId: network.chainId,
          nonce,
          to: network.token.address,
          data,
          gas,
          gasPrice,
        });
      } catch (error) {
        return {
          kind: "refused",
          reason: reason("INVALID_CREDENTIAL", {
            message: `The transfer could not be signed: ${error instanceof Error ? error.message : "unknown error"}.`,
          }),
        };
      }

      return {
        kind: "signed",
        transfer: {
          rawTransaction,
          // The hash of a signed transaction is the hash of its bytes, so identical
          // bytes are one transaction — the property a retry relies on.
          txHash: keccak256(rawTransaction),
          nonce,
          fromAddress: wallet.address,
          tokenAddress: network.token.address,
          netMinor: input.netMinor,
          gasLimit: gas.toString(),
          gasPriceWei: gasPrice.toString(),
        },
      };
    },

    async prepareCancel(input) {
      if (!endpoint) return { kind: "refused", reason: unconfigured };
      const wallet = senderWallet(policy);
      if (!wallet.ok) return { kind: "refused", reason: wallet.reason };

      const price = await rpcCall(endpoint, "eth_gasPrice", [], fetcher);
      if (!price.ok) return { kind: "refused", reason: price.reason };
      const chainPrice = hexQuantity(price.result);
      if (chainPrice === null) {
        return {
          kind: "refused",
          reason: reason("NETWORK_UNAVAILABLE", {
            providerId: PROVIDER_IDS.alchemyRpc,
            message: "The network did not answer with a usable gas price, so no replacement was signed.",
          }),
        };
      }
      // Strictly above the fee the original was signed with: a replacement priced at the
      // same fee can be rejected as "already known", and one priced below can never
      // replace anything.
      const required = (BigInt(input.aboveGasPriceWei) * BigInt(125)) / BigInt(100);
      const gasPrice = chainPrice > required ? chainPrice : required;

      let rawTransaction: Hex;
      try {
        rawTransaction = await wallet.signTransaction({
          chainId: network.chainId,
          nonce: input.nonce,
          to: wallet.address,
          data: "0x",
          gas: BigInt(21_000),
          gasPrice,
        });
      } catch (error) {
        return {
          kind: "refused",
          reason: reason("INVALID_CREDENTIAL", {
            message: `The replacement transaction could not be signed: ${error instanceof Error ? error.message : "unknown error"}.`,
          }),
        };
      }
      return {
        kind: "signed",
        transfer: {
          rawTransaction,
          txHash: keccak256(rawTransaction),
          nonce: input.nonce,
          fromAddress: wallet.address,
          tokenAddress: network.token.address,
          netMinor: "0",
          gasLimit: "21000",
          gasPriceWei: gasPrice.toString(),
        },
      };
    },

    async broadcast({ rawTransaction }) {
      if (!endpoint) return { kind: "refused", reason: unconfigured };
      const answer = await rpcCall(endpoint, "eth_sendRawTransaction", [rawTransaction], fetcher);
      if (!answer.ok) return { kind: "refused", reason: answer.reason };
      const hash = typeof answer.result === "string" && /^0x[0-9a-fA-F]{64}$/.test(answer.result) ? answer.result : null;
      if (!hash) {
        return {
          kind: "refused",
          reason: reason("NETWORK_UNAVAILABLE", {
            providerId: PROVIDER_IDS.alchemyRpc,
            message: "The network accepted the request but did not answer with a transaction hash.",
          }),
        };
      }
      return { kind: "accepted", txHash: hash };
    },

    async observe({ txHash, confirmationsKnown }) {
      if (!endpoint) return { kind: "unknown", reason: unconfigured };
      const receipt = await rpcCall(endpoint, "eth_getTransactionReceipt", [txHash], fetcher);
      if (!receipt.ok) return { kind: "unknown", reason: receipt.reason };
      if (receipt.result === null || receipt.result === undefined) {
        // Not mined yet — the honest answer for a transfer that is on its way, and never
        // a confirmation count this code invents.
        return { kind: "pending", confirmations: confirmationsKnown };
      }
      const record = typeof receipt.result === "object" ? (receipt.result as Record<string, unknown>) : {};
      const blockNumber = hexQuantity(record.blockNumber);
      if (blockNumber === null) {
        return {
          kind: "unknown",
          reason: reason("PROVIDER_ERROR", {
            providerId: PROVIDER_IDS.alchemyRpc,
            message: "The receipt carried no usable block number.",
          }),
        };
      }
      const head = await rpcCall(endpoint, "eth_blockNumber", [], fetcher);
      if (!head.ok) return { kind: "unknown", reason: head.reason };
      const headNumber = hexQuantity(head.result);
      if (headNumber === null) {
        return {
          kind: "unknown",
          reason: reason("NETWORK_UNAVAILABLE", {
            providerId: PROVIDER_IDS.alchemyRpc,
            message: "The network did not answer with a block height, so confirmations could not be counted.",
          }),
        };
      }
      return {
        kind: "mined",
        // Anything that is not a `1` status is not a success. A receipt without a status
        // predates EIP-658 and cannot be read as one, so it is treated as the answer that
        // does not move money rather than the one that does.
        status: record.status === "0x1" ? "success" : "reverted",
        confirmations: Number(headNumber - blockNumber) + 1,
        blockNumber: Number(blockNumber),
      };
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The simulated port: the same signatures, and no chain.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How many confirmations one check grants in simulation.
 *
 * One, so the states between a send and a settlement are states a person actually sees:
 * the pass that sends leaves the row at one confirmation against the network's count, with
 * the hash on screen and the amount still reserved, and the next check confirms it. Four per
 * check would settle a two-confirmation network in the same breath as it was sent, which is
 * not how any chain behaves and would make "watch it move through reserved, broadcast and
 * confirmed" impossible to do by hand.
 *
 * The cost is one check per confirmation, so a high-confirmation network takes that many
 * passes in development. Those are polls, not minutes — the processor runs every
 * `WITHDRAWAL_PROCESS_INTERVAL_MINUTES`, and the panel's check button asks for one at a time —
 * and this is a stand-in besides. A development constant rather than policy, which is why it
 * is here and not in the environment.
 */
export const SIMULATED_CONFIRMATIONS_PER_CHECK = 1;
/** Where simulated blocks are numbered from, so a simulated block is never mistaken for a real one. */
export const SIMULATED_BLOCK_ORIGIN = 900_000_000;

export const SIMULATED_CHAIN_ID = "simulated-evm";

/**
 * A chain that signs for real and sends nothing.
 *
 * The signature is a real signature by the real wallet over the real transfer, so the
 * bytes on the row — and the hash derived from them — are what a real deployment would
 * send. What does not happen is the send: the port accepts the bytes and the observation
 * advances the confirmation count by a fixed step. Two consequences worth stating: a
 * simulated confirmation is a promise the code kept, not evidence the chain moved, and
 * every surface that shows one says it was simulated (see
 * {@link WithdrawalChainPort.simulated}), so it can never be read as a real confirmation.
 *
 * Development-only by construction: {@link readWithdrawalPolicy} refuses `simulated`
 * outside `NODE_ENV=development`, so a deployment cannot be left in this mode by a stray
 * environment value.
 */
export function createSimulatedWithdrawalChain(
  policy: WithdrawalPolicy,
  network: WithdrawalNetworkPolicy,
  options: { failure?: WithdrawalPolicy["simulatedFailure"] } = {},
): WithdrawalChainPort {
  const failure = options.failure ?? policy.simulatedFailure;
  const unreachable = (): Reason =>
    reason("NETWORK_UNAVAILABLE", {
      message:
        "The simulated network is configured to be unreachable (WITHDRAWAL_SIMULATE_FAILURE), so nothing was sent.",
    });

  return {
    id: `${SIMULATED_CHAIN_ID}:${network.slug}`,
    simulated: true,

    sender() {
      const wallet = senderWallet(policy);
      return wallet.ok ? { kind: "ready", address: wallet.address } : { kind: "unavailable", reason: wallet.reason };
    },

    async prepare(input) {
      const wallet = senderWallet(policy);
      if (!wallet.ok) return { kind: "refused", reason: wallet.reason };
      if (failure === "rpc-unavailable") return { kind: "refused", reason: unreachable() };
      const nonce = input.nonce ?? 0;
      const data = erc20TransferData(input.to, input.netMinor);
      let rawTransaction: Hex;
      try {
        rawTransaction = await wallet.signTransaction({
          chainId: network.chainId,
          nonce,
          to: network.token.address,
          data,
          gas: SIMULATED_GAS_LIMIT,
          gasPrice: SIMULATED_GAS_PRICE_WEI,
        });
      } catch (error) {
        return {
          kind: "refused",
          reason: reason("INVALID_CREDENTIAL", {
            message: `The simulated transfer could not be signed: ${error instanceof Error ? error.message : "unknown error"}.`,
          }),
        };
      }
      return {
        kind: "signed",
        transfer: {
          rawTransaction,
          txHash: keccak256(rawTransaction),
          nonce,
          fromAddress: wallet.address,
          tokenAddress: network.token.address,
          netMinor: input.netMinor,
          gasLimit: SIMULATED_GAS_LIMIT.toString(),
          gasPriceWei: SIMULATED_GAS_PRICE_WEI.toString(),
        },
      };
    },

    async prepareCancel(input) {
      const wallet = senderWallet(policy);
      if (!wallet.ok) return { kind: "refused", reason: wallet.reason };
      if (failure === "rpc-unavailable") return { kind: "refused", reason: unreachable() };
      const gasPrice = (BigInt(input.aboveGasPriceWei) * BigInt(125)) / BigInt(100);
      try {
        const rawTransaction = await wallet.signTransaction({
          chainId: network.chainId,
          nonce: input.nonce,
          to: wallet.address,
          data: "0x",
          gas: BigInt(21_000),
          gasPrice,
        });
        return {
          kind: "signed",
          transfer: {
            rawTransaction,
            txHash: keccak256(rawTransaction),
            nonce: input.nonce,
            fromAddress: wallet.address,
            tokenAddress: network.token.address,
            netMinor: "0",
            gasLimit: "21000",
            gasPriceWei: gasPrice.toString(),
          },
        };
      } catch (error) {
        return {
          kind: "refused",
          reason: reason("INVALID_CREDENTIAL", {
            message: `The replacement transaction could not be signed: ${error instanceof Error ? error.message : "unknown error"}.`,
          }),
        };
      }
    },

    async broadcast({ rawTransaction }) {
      if (failure === "rpc-unavailable") return { kind: "refused", reason: unreachable() };
      if (failure === "nonce-conflict") {
        // A node refuses `eth_sendRawTransaction` when the nonce is already spoken for, and that
        // refusal is the *send* failing — not a send that succeeded and something later going
        // wrong — which is why this failure is here rather than in `observe`. The sentence is the
        // node's own shape, the same one the real port derives from the RPC error text.
        return {
          kind: "refused",
          reason: reason("NONCE_CONFLICT", {
            message:
              'The simulated network refused the send because the nonce was already used (WITHDRAWAL_SIMULATE_FAILURE): {"code":-32000,"message":"nonce too low"}',
          }),
        };
      }
      // The hash is of the bytes, so re-sending the same bytes is the same transaction
      // here exactly as it is on a node that deduplicates by hash.
      return { kind: "accepted", txHash: keccak256(rawTransaction as Hex) };
    },

    async observe({ confirmationsKnown }) {
      if (failure === "rpc-unavailable") return { kind: "unknown", reason: unreachable() };
      const confirmations = confirmationsKnown + SIMULATED_CONFIRMATIONS_PER_CHECK;
      return {
        kind: "mined",
        status: failure === "reverted" ? "reverted" : "success",
        confirmations,
        blockNumber: SIMULATED_BLOCK_ORIGIN + confirmations,
      };
    },
  };
}
