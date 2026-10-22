/**
 * One API refusal with a status, a stable code and a sentence a caller can act on.
 *
 * The code is the contract (tests and clients key off it); the message is for the human
 * reading the response. A refusal raised inside a service is caught once by the route
 * handler, so a service never builds a `Response` and the MCP server can reuse the same
 * failure as text.
 */
export class ApiProblem extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: Record<string, unknown> | null;

  constructor(status: number, code: string, message: string, detail: Record<string, unknown> | null = null) {
    super(message);
    this.name = "ApiProblem";
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

/** A handler's non-200 success, e.g. 202 for a created approval. */
export class ApiResult {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {}
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
