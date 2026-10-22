import { encodeFunctionData, type Hex } from "viem";
import { instrumentFetch, PROVIDER_IDS } from "@/lib/observability/provider-call";
import { getEvmMainnet } from "@/lib/portfolio/evm-mainnets";
import { resolveRpcEndpoint, rpcConfigurationVariableName } from "@/lib/rpc/networks";

/**
 * Contract wallets: how a signature that no EOA produced is verified.
 *
 * Addresses on an EVM chain are either an externally owned account (a key pair)
 * or a contract. Phase 07 verified the first kind — `ecrecover` the signer and
 * compare it with the claimed address — which is a pure operation on the
 * signature. A contract wallet — a Safe, an Argent account, a 4337 smart
 * account, a counterfactual delegation account — has no key at its address and
 * cannot be verified that way at all: the contract itself decides whether a
 * signature it was handed is acceptable, by implementing EIP-1271.
 *
 * That decision lives on chain, so this module has three jobs, and only the
 * middle one needs a network:
 *
 *   1. build exactly the call the standard defines — `isValidSignature(bytes32
 *      hash, bytes signature)`, where the hash is the EIP-191 hash of the SIWE
 *      message text the wallet displayed and signed;
 *   2. make it, on **the chain the signed message names**, through the same
 *      key-bearing RPC resolution the rest of the application uses, with a
 *      bounded timeout and one batched round trip;
 *   3. turn every outcome into something the caller can be unambiguous about:
 *      accepted, refused, or *not checkable* — and never "accepted" by default.
 *
 * The distinction the last point draws is the whole of requirement 4. A relay
 * timeout, an unreachable node, a chain with no configured endpoint, an address
 * with no bytecode at all: none of those are a signature. They are separate
 * reasons, they carry their own sentence, and they are reported as failures the
 * user can retry — never as an accepted sign-in.
 */

/** The two kinds of account this application can sign in. */
export const ACCOUNT_TYPES = ["EOA", "CONTRACT"] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

/** Validates a value read back from storage; anything unknown reads as an EOA. */
export function isAccountType(value: unknown): value is AccountType {
  return typeof value === "string" && (ACCOUNT_TYPES as readonly string[]).includes(value);
}

/** How the account type reads to a person, in the admin directory and the session view. */
export function accountTypeLabel(type: AccountType): string {
  return type === "CONTRACT"
    ? "Contract wallet (EIP-1271)"
    : "Externally owned account (EOA)";
}

/**
 * The selector of `isValidSignature(bytes32,bytes)` and the magic value it must
 * return are the same four bytes. They are different things — one goes in the
 * calldata, the other comes back in the result — so they are named separately
 * rather than sharing a constant that would read as a coincidence.
 */
export const IS_VALID_SIGNATURE_SELECTOR = "0x1626ba7e";
export const EIP1271_MAGIC_VALUE = "0x1626ba7e";

/** What each chain's own RPC call answered. */
export type ContractSignatureReading =
  | { ok: true; valid: true; answer: string }
  | { ok: true; valid: false; answer: string }
  | { ok: false; reason: ContractUnverifiableReason; detail?: string };

/**
 * Every way a contract-wallet verification can fail to reach a verdict. Each one
 * is distinct because each one means something different to the person reading
 * it: configure an endpoint, fix the endpoint, wait and retry, or stop using an
 * address that is not a contract.
 */
export type ContractUnverifiableReason =
  | "chain-unknown"
  | "rpc-unconfigured"
  | "rpc-unreachable"
  | "rpc-timeout"
  | "rpc-error"
  | "chain-mismatch"
  | "not-deployed";

/** A signature whose verification could not be completed. */
export type ContractAccountVerifier = (input: {
  /** The address the SIWE message claims, and the contract that must judge it. */
  address: string;
  /** The chain the message is bound to. The call is made only on this chain. */
  chainId: number;
  /** EIP-191 hash of the exact SIWE message text the wallet signed. */
  messageHash: Hex;
  /** The signature, as bytes: EIP-1271 implementations accept any encoding. */
  signature: Hex;
}) => Promise<ContractSignatureReading>;

/**
 * Whether a check that could not be completed is worth trying again.
 *
 * Two of the reasons are settled facts about the world and will be just as true
 * on the next attempt: there is no contract at that address, and the endpoint is
 * answering for a chain the signature is not bound to. The rest are the network
 * and this deployment's configuration — a node that did not answer, a chain with
 * no endpoint — and those are the retryable ones.
 */
export function isRetryableUnverifiableReason(reason: ContractUnverifiableReason): boolean {
  return reason === "rpc-unreachable" || reason === "rpc-timeout" || reason === "rpc-error";
}

export const CONTRACT_VERIFICATION_TIMEOUT_MS = 5_000;

/** The calldata for `isValidSignature(bytes32,bytes)`. */
export function encodeIsValidSignatureCall(input: { hash: Hex; signature: Hex }): Hex {
  return encodeFunctionData({
    abi: [
      {
        type: "function",
        name: "isValidSignature",
        stateMutability: "view",
        inputs: [
          { name: "hash", type: "bytes32" },
          { name: "signature", type: "bytes" },
        ],
        outputs: [{ name: "magicValue", type: "bytes4" }],
      },
    ] as const,
    functionName: "isValidSignature",
    args: [input.hash, input.signature],
  });
}

/**
 * Whether a contract's answer is the standard's acceptance.
 *
 * EIP-1271: "The magic value 0x1626ba7e must be returned for a valid signature.
 * The function should revert, or return any value other than the magic value,
 * for an invalid one." So this is deliberately an equality test with one
 * expected value — every other shape, including an empty answer or a longer one
 * that merely starts with those bytes, is a refusal.
 */
export function isAcceptedSignatureAnswer(value: unknown): boolean {
  return typeof value === "string" && value.trim().toLowerCase() === EIP1271_MAGIC_VALUE;
}

type JsonRpcAnswer = Map<number, { result?: unknown; error?: unknown }>;

function readAnswers(payload: unknown): JsonRpcAnswer {
  const answers: JsonRpcAnswer = new Map();
  if (!Array.isArray(payload)) return answers;
  for (const item of payload) {
    if (typeof item !== "object" || item === null) continue;
    const entry = item as { id?: unknown; result?: unknown; error?: unknown };
    if (!Number.isSafeInteger(entry.id)) continue;
    answers.set(entry.id as number, { result: entry.result, error: entry.error });
  }
  return answers;
}

function isHexResult(value: unknown): value is string {
  return typeof value === "string" && /^0x[0-9a-fA-F]*$/.test(value);
}

/**
 * Ask the chain the message names whether it accepts this signature.
 *
 * One batched request carries all three questions the answer depends on, so the
 * verdict cannot come from a mixture of chains:
 *
 *   - `eth_chainId`, so an endpoint pointed at the wrong network is caught
 *     rather than trusted (the message's chain is what the binding means, and an
 *     endpoint that answers with a different one is a deployment mistake, not a
 *     signature);
 *   - `eth_getCode`, so an address with no contract at all is its own outcome
 *     instead of an empty `eth_call` being read as a refusal;
 *   - `eth_call` to `isValidSignature`, whose answer is the verdict.
 *
 * A JSON-RPC error from the `eth_call` itself is the standard's own refusal —
 * implementations are told to revert for an invalid signature — so it is
 * reported as an invalid signature rather than as an unavailable check. Errors
 * from the *transport*, the chain id or the code read are not verdicts at all
 * and are reported as unverifiable.
 */
export async function readContractSignature(input: {
  address: string;
  chainId: number;
  messageHash: Hex;
  signature: Hex;
  fetcher?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<ContractSignatureReading> {
  const network = getEvmMainnet(input.chainId);
  if (!network) return { ok: false, reason: "chain-unknown", detail: String(input.chainId) };

  const resolution = resolveRpcEndpoint(network.alchemyNetwork, input.env ?? process.env);
  if (!resolution.ok) {
    return {
      ok: false,
      reason: "rpc-unconfigured",
      detail: rpcConfigurationVariableName(network.alchemyNetwork) ?? undefined,
    };
  }

  const calls = [
    { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] as unknown[] },
    { jsonrpc: "2.0", id: 2, method: "eth_getCode", params: [input.address, "latest"] as unknown[] },
    {
      jsonrpc: "2.0",
      id: 3,
      method: "eth_call",
      params: [
        { to: input.address, data: encodeIsValidSignatureCall({ hash: input.messageHash, signature: input.signature }) },
        "latest",
      ] as unknown[],
    },
  ];

  // Recorded like every other outbound call. The endpoint carries the Alchemy
  // key in its path, so the record stores the redacted URL, never the endpoint.
  const request = instrumentFetch({ providerId: PROVIDER_IDS.alchemyRpc, fetcher: input.fetcher ?? fetch });
  let payload: unknown;
  try {
    const response = await request(resolution.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(calls),
      cache: "no-store",
      signal: AbortSignal.timeout(input.timeoutMs ?? CONTRACT_VERIFICATION_TIMEOUT_MS),
    });
    if (!response.ok) return { ok: false, reason: "rpc-error", detail: String(response.status) };
    payload = await response.json();
  } catch (error) {
    // A timeout and an unreachable host are different problems for the person
    // reading them: one is "try again", the other is "something is wrong".
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return { ok: false, reason: timedOut ? "rpc-timeout" : "rpc-unreachable" };
  }

  const answers = readAnswers(payload);
  const reportedChain = answers.get(1)?.result;
  if (!isHexResult(reportedChain)) return { ok: false, reason: "rpc-error", detail: "eth_chainId" };
  if (Number.parseInt(reportedChain, 16) !== input.chainId) {
    return { ok: false, reason: "chain-mismatch", detail: `${reportedChain} for chain ${input.chainId}` };
  }

  const code = answers.get(2)?.result;
  if (!isHexResult(code)) return { ok: false, reason: "rpc-error", detail: "eth_getCode" };
  if (code === "0x") return { ok: false, reason: "not-deployed", detail: input.address };

  const verdict = answers.get(3);
  if (verdict?.error) {
    // The contract's own refusal, per the standard.
    return { ok: true, valid: false, answer: "(the call reverted)" };
  }
  if (!isHexResult(verdict?.result)) return { ok: false, reason: "rpc-error", detail: "eth_call" };
  return { ok: true, valid: isAcceptedSignatureAnswer(verdict.result), answer: verdict.result };
}

/** The real verifier: the chain's own RPC, with the same resolution the portfolio reads use. */
export function createContractAccountVerifier(
  deps: { fetcher?: typeof fetch; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): ContractAccountVerifier {
  return (input) => readContractSignature({ ...input, ...deps });
}

/**
 * One sentence per reason, written for whoever is looking at the login page —
 * and every one of them says the same crucial thing: nothing was accepted.
 */
export function describeContractVerificationFailure(
  reason: ContractUnverifiableReason,
  detail?: string,
): string {
  const nothing = "Nothing was signed in and no session was created.";
  switch (reason) {
    case "chain-unknown":
      return `This deployment cannot check a contract wallet's signature on chain ${detail ?? "that chain"}, because it has no RPC configuration for it. ${nothing} Sign in with an account on a supported chain, or add that chain's RPC endpoint and try again.`;
    case "rpc-unconfigured":
      return `A contract wallet signs with a call to its own contract, and this deployment has no RPC endpoint to make it with${
        detail ? ` (${detail} is not configured)` : ""
      }. ${nothing} An externally owned account (a key-based wallet) can still sign in.`;
    case "rpc-unreachable":
      return `The RPC endpoint that has to check this contract wallet's signature could not be reached, so the signature was not checked and was not accepted. ${nothing} Check this deployment's connection and try again.`;
    case "rpc-timeout":
      return `Checking this contract wallet's signature against its contract took too long, so the check was abandoned and the signature was not accepted. ${nothing} Try again, or sign in with an externally owned account.`;
    case "rpc-error":
      return `The RPC endpoint answered the contract-wallet check with an error${
        detail ? ` (${detail})` : ""
      }, so the signature could not be verified and was not accepted. ${nothing} Try again shortly.`;
    case "chain-mismatch":
      return `The RPC endpoint is answering for a different chain than the one the signature is bound to${detail ? ` (${detail})` : ""}, so its answer could not be trusted and the signature was not accepted. ${nothing} This is a deployment misconfiguration: fix the endpoint for this chain and try again.`;
    case "not-deployed":
      return `There is no contract deployed at this address on the chain the signature names, so it cannot be a contract wallet there and the signature was not accepted. ${nothing} If the account is counterfactual it has to be deployed first — or sign in with an externally owned account.`;
  }
}
