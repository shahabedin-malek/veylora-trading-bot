import { isDevelopmentMode, type EnvironmentLike } from "@/lib/dev-mode/mode";

/**
 * Structured server logging, with the redaction pass that makes it safe.
 *
 * Two rules decide every line this module writes:
 *
 *  1. A key-like value never reaches a log line, a response or a stored record.
 *     Redaction runs on *field names* and on *value shapes*, because a secret
 *     arrives in both: `{ apiKey: "…" }` is a named field, and an Alchemy
 *     endpoint carries its key in the path of a URL that has no secret-shaped
 *     field name at all.
 *  2. Development tells the truth and production stays quiet. A failure keeps
 *     its stack, its provider body and the name of the variable that is missing
 *     locally; the same failure on a deployed instance says what a caller can
 *     act on and nothing that helps an attacker.
 */

export const REDACTED = "[redacted]";
export const MAX_LOG_STRING = 2_000;
const MAX_LOG_DEPTH = 6;
const MAX_LOG_ENTRIES = 50;

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Field names whose value is never loggable. Deliberately broader than the
 * credential names this app happens to use today: an added integration names
 * its key whatever its vendor does, and this list has to still be right.
 */
const SECRET_FIELD_PATTERN =
  /(?:^|[^a-z])(?:api[_-]?key|apikey|access[_-]?key|key|secret|token|password|passwd|passphrase|private[_-]?key|mnemonic|seed[_-]?phrase|signature|credential|authorization|cookie|session[_-]?secret|bearer)(?:$|[^a-z])/i;

/**
 * A key carried in a URL path segment, which is how Alchemy endpoints work:
 * https://eth-mainnet.g.alchemy.com/v2/<key>. The version prefix keeps an
 * ordinary path from being redacted into uselessness.
 */
const KEY_IN_PATH_PATTERN = /(\/(?:v2|v3|api\/v2)\/)[A-Za-z0-9_-]{20,}/gi;

/**
 * Value shapes that are a secret no matter which field they arrived in. Ordered
 * from the most specific to the most general, because the general ones
 * (a long hex or base64 blob) would otherwise hide the specific ones.
 */
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  // Vendor token prefixes: `sk-live-…`, `pk_test_…`.
  /\b(?:sk|pk|rk|ak)[-_][A-Za-z0-9_-]{12,}/g,
  // An Authorization header value that survived into a field without its name.
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi,
  // A signed JSON Web Token.
  /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g,
  // A key carried in a query string, or in a bare `key=value` fragment that a
  // message or a field value happens to hold.
  /((?:^|[?&\s])(?:api[_-]?key|apikey|access[_-]?token|key|token|auth|secret|signature)=)[^&\s"']+/gi,
  // A key carried in a URL path segment (see KEY_IN_PATH_PATTERN).
  KEY_IN_PATH_PATTERN,
  // Basic-auth credentials embedded in a URL.
  /(https?:\/\/)[^/@\s:]+:[^/@\s]+@/gi,
];

/**
 * Whole-string shapes, for the case where a value arrives with no field name to
 * judge it by (a key passed straight into a message, for example).
 *
 * Two shapes are deliberately exempt. An EVM address (`0x` + 40 hex) is public
 * identity and the app's own data — masking it in development would hide the one
 * thing a portfolio failure needs to name. A 32-byte hex value is redacted
 * whichever it is: a response hash can be regenerated from the source, a private
 * key cannot be un-leaked.
 */
const PUBLIC_HEX_ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;
const SECRET_ONLY_STRING_PATTERNS: readonly RegExp[] = [
  /^0x[a-fA-F0-9]{64}$/, // a private key (32 bytes, 0x-prefixed)
  /^[a-f0-9]{64}$/i, // 32 random bytes, hex — the credential-encryption key shape
  /^[A-Za-z0-9+/]{40,}={0,2}$/, // a long base64 or base58 blob with no other structure
];

/** A URL whose search parameters carry credentials. */
const SENSITIVE_PARAM = /(?:api[_-]?key|apikey|access[_-]?token|auth|key|token|secret|signature|password|credential)/i;

/** True when the whole string is a secret and nothing else. */
export function isSecretOnlyString(value: string): boolean {
  if (PUBLIC_HEX_ADDRESS_PATTERN.test(value)) return false;
  return SECRET_ONLY_STRING_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * Replace every match of a pattern with the marker, keeping the pattern's own
 * capture group when it has one (the URL prefix that says *where* the key sat).
 *
 * The `...rest` shape matters: with a capture group it is `[group, offset,
 * whole]`, without one it is `[offset, whole]`. Reading the first argument as a
 * prefix unconditionally would print the match offset instead of the marker.
 */
function redactMatches(value: string, pattern: RegExp): string {
  return value.replace(pattern, (match: string, ...rest: unknown[]) => {
    const groups = rest.slice(0, Math.max(0, rest.length - 2));
    const prefix = typeof groups[0] === "string" ? groups[0] : "";
    return `${prefix}${REDACTED}`;
  });
}

/** Apply the value-shape rules to one string. */
export function redactString(value: string): string {
  if (isSecretOnlyString(value)) return REDACTED;
  return SECRET_VALUE_PATTERNS.reduce((current, pattern) => redactMatches(current, pattern), value);
}

/**
 * Redact a URL for logging or storage: credentials in the userinfo, in a path
 * segment, or in a query parameter are replaced, and the rest of the URL is
 * kept so the line still says what was called.
 */
export function redactUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return redactString(trimmed).slice(0, MAX_LOG_STRING);
  }
  // Embedded credentials are dropped rather than marked: a marked username
  // would still name the account, and the URL is more useful without it.
  url.username = "";
  url.password = "";
  for (const key of [...url.searchParams.keys()]) {
    if (SENSITIVE_PARAM.test(key)) url.searchParams.set(key, REDACTED);
  }
  url.pathname = redactMatches(url.pathname, KEY_IN_PATH_PATTERN);
  return redactString(url.toString()).slice(0, MAX_LOG_STRING);
}

/** True when a field name must not carry a value into a log line. */
export function isSecretField(key: string): boolean {
  return SECRET_FIELD_PATTERN.test(key);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

/**
 * The redaction pass. Field names are checked first, then values: strings,
 * numbers and booleans are shaped, errors are serialized, arrays and objects
 * are walked, and anything else (a function, a stream, a Buffer) is described
 * rather than printed.
 */
export function redactValue(value: unknown, depth = 0, environment: EnvironmentLike = process.env): unknown {
  if (depth > MAX_LOG_DEPTH) return "[depth limit]";
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return redactString(value).slice(0, MAX_LOG_STRING);
  if (typeof value === "undefined") return undefined;
  if (value instanceof Error) return serializeError(value, environment);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return value.slice(0, MAX_LOG_ENTRIES).map((item) => redactValue(item, depth + 1, environment));
  }
  if (!isPlainObject(value)) return `[${typeof value}]`;
  return redactFields(value, depth, environment);
}

/** Redact an object by field name, then by value. */
export function redactFields(
  fields: Record<string, unknown>,
  depth = 0,
  environment: EnvironmentLike = process.env,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields).slice(0, MAX_LOG_ENTRIES)) {
    if (isSecretField(key)) {
      result[key] = REDACTED;
      continue;
    }
    const redacted = redactValue(value, depth + 1, environment);
    if (redacted !== undefined) result[key] = redacted;
  }
  return result;
}

export type SerializedError = {
  name: string;
  message: string;
  code?: string;
  stack?: string;
  details?: unknown;
};

/**
 * An error, in the detail the current environment deserves.
 *
 * Development keeps the stack and the provider body, because a value that could
 * not be fetched should say why without a debugger. Production keeps the name,
 * the message and a machine-readable code only.
 */
export function serializeError(error: unknown, environment: EnvironmentLike = process.env): SerializedError {
  const development = isDevelopmentMode(environment);
  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code;
    const details = (error as Error & { details?: unknown }).details ?? (error as Error & { cause?: unknown }).cause;
    const serialized: SerializedError = {
      name: error.name || "Error",
      message: redactString(error.message || "No error message was provided.").slice(0, MAX_LOG_STRING),
    };
    if (typeof code === "string" || typeof code === "number") serialized.code = String(code);
    // The provider body and the stack are development affordances: they say why
    // in the place the failure happened, and never leave the deployment.
    if (development && details !== undefined) {
      const redactedDetails = redactValue(details, 0, environment);
      if (redactedDetails !== undefined) serialized.details = redactedDetails;
    }
    if (development && typeof error.stack === "string") {
      serialized.stack = redactString(error.stack).slice(0, 4_000);
    }
    return serialized;
  }
  if (typeof error === "string") return { name: "Error", message: redactString(error).slice(0, MAX_LOG_STRING) };
  return { name: "Error", message: `Non-error failure: ${typeof error}` };
}

export type LogRecord = {
  level: LogLevel;
  timestamp: string;
  message: string;
  requestId: string | null;
  route: string | null;
  [key: string]: unknown;
};

export type LogSink = (record: LogRecord) => void;

/** A child logger, so a request does not re-declare its own id on every line. */
export type Logger = {
  readonly requestId: string | null;
  readonly route: string | null;
  child(bindings: { requestId?: string | null; route?: string | null }): Logger;
  configure(key: string, value: string | number | boolean): Logger;
  debug(message: string, fields?: Record<string, unknown>): LogRecord;
  info(message: string, fields?: Record<string, unknown>): LogRecord;
  warn(message: string, fields?: Record<string, unknown>): LogRecord;
  error(message: string, fields?: Record<string, unknown>): LogRecord;
};

/** The `LOG_LEVEL` value, or the level this environment should default to. */
export function resolveLogLevel(environment: EnvironmentLike = process.env): LogLevel {
  const configured = environment.LOG_LEVEL?.trim().toLowerCase();
  if (configured === "debug" || configured === "info" || configured === "warn" || configured === "error") return configured;
  // Development logs every provider call; anywhere else only what went wrong.
  return isDevelopmentMode(environment) ? "debug" : "info";
}

/** The default sink: one JSON object per line on stdout. */
export function jsonLogSink(write: (line: string) => void = (line) => process.stdout.write(line)): LogSink {
  return (record) => {
    write(`${JSON.stringify(record)}\n`);
  };
}

export type LoggerOptions = {
  requestId?: string | null;
  route?: string | null;
  level?: LogLevel;
  sink?: LogSink;
  environment?: EnvironmentLike;
  /** Extra fields every line from this logger carries, redacted like the rest. */
  bindings?: Record<string, unknown>;
};

export function createLogger(options: LoggerOptions = {}): Logger {
  const environment = options.environment ?? process.env;
  const level = options.level ?? resolveLogLevel(environment);
  const sink = options.sink ?? jsonLogSink();
  const requestId = options.requestId ?? null;
  const route = options.route ?? null;
  const bindings = options.bindings ?? {};

  function emit(currentLevel: LogLevel, message: string, fields?: Record<string, unknown>): LogRecord {
    const record: LogRecord = {
      level: currentLevel,
      timestamp: new Date().toISOString(),
      message: redactString(message).slice(0, MAX_LOG_STRING),
      requestId,
      route,
      ...redactFields({ ...bindings, ...(fields ?? {}) }, 0, environment),
    };
    // Filtering happens after the record is built, so a caller that wants the
    // record (a test, a record writer) gets it regardless of the sink's level.
    if (LEVEL_RANK[currentLevel] >= LEVEL_RANK[level]) sink(record);
    return record;
  }

  return {
    requestId,
    route,
    child: (childBindings) =>
      createLogger({
        ...options,
        requestId: childBindings.requestId ?? requestId,
        route: childBindings.route ?? route,
      }),
    configure: (key, value) => createLogger({ ...options, bindings: { ...bindings, [key]: value } }),
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
  };
}
