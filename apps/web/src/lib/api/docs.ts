import { API_ROUTES, type ApiField, type ApiRouteSpec } from "@/lib/api/routes";
import {
  API_KEY_SCOPES,
  API_SCOPE_DETAIL,
  DEFAULT_API_RATE_LIMIT_PER_MINUTE,
  type ApiScope,
} from "@/lib/api/keys";

/**
 * `/docs/api`, generated from the same table the handler dispatches.
 *
 * The docs cannot disagree with the code because there is no second list: the method, path,
 * scope, query fields, body fields and description all come from the route spec. The only
 * values written here are the placeholder key and the example response, and a test checks
 * that every generated example carries the placeholder rather than anything that could look
 * like a real credential.
 */

export const API_BASE_PATH = "/api/v1";
export const API_PLACEHOLDER_KEY = "vyl_replace_me";
export const API_DOCS_PATH = "/docs/api";
export const API_RATE_LIMIT_DEFAULT = DEFAULT_API_RATE_LIMIT_PER_MINUTE;
export const API_RATE_LIMIT_HEADERS = ["X-RateLimit-Limit", "X-RateLimit-Remaining", "X-RateLimit-Reset"];

export type DocumentedRoute = ApiRouteSpec & {
  fullPath: string;
  curl: string;
  bodyExample: Record<string, unknown> | null;
};

function exampleValue(field: ApiField): unknown {
  if (field.name === "market") return "BTC-USD";
  if (field.name === "side") return "BUY";
  if (field.name === "orderType") return "MARKET";
  if (field.name === "quantity") return "0.001";
  if (field.name === "limitPrice") return "60000";
  if (field.name === "stopLossPrice") return "58000";
  if (field.name === "agentAccountId") return "agent_replace_me";
  if (field.type === "integer") return 25;
  if (field.type === "date") return "2026-09-19";
  return "replace_me";
}

function bodyExample(spec: ApiRouteSpec): Record<string, unknown> | null {
  if (!spec.body || spec.body.length === 0) return null;
  const body: Record<string, unknown> = {};
  for (const field of spec.body) {
    if (field.required || field.name === "stopLossPrice") body[field.name] = exampleValue(field);
  }
  return body;
}

function curlFor(spec: ApiRouteSpec, body: Record<string, unknown> | null): string {
  const prefix = spec.method === "GET" ? "curl -s" : "curl -s -X POST";
  const lines = [`${prefix} http://localhost:3000${API_BASE_PATH}${spec.path} \\`];
  lines.push(`  -H "Authorization: Bearer ${API_PLACEHOLDER_KEY}"`);
  if (spec.method === "POST") {
    lines[lines.length - 1] += " \\";
    lines.push('  -H "Content-Type: application/json" \\');
    lines.push(`  -d '${JSON.stringify(body ?? {})}'`);
  }
  return lines.join("\n");
}

export function documentedRoutes(routes: readonly ApiRouteSpec[] = API_ROUTES): DocumentedRoute[] {
  return routes.map((spec) => {
    const body = bodyExample(spec);
    return {
      ...spec,
      fullPath: `${API_BASE_PATH}${spec.path}`,
      bodyExample: body,
      curl: curlFor(spec, body),
    };
  });
}

export function documentedScopes(): Array<{ scope: ApiScope; detail: string }> {
  return API_KEY_SCOPES.map((scope) => ({ scope, detail: API_SCOPE_DETAIL[scope] }));
}

export const MCP_SERVER_NAME = "veylora";
export const MCP_PACKAGE_SCRIPT = "pnpm --config.verify-deps-before-run=false mcp";

export const MCP_CLIENT_CONFIG = `{
  "mcpServers": {
    "veylora": {
      "command": "pnpm",
      "args": ["--dir", "/absolute/path/to/trading-ai-ds/apps/web", "mcp"],
      "env": {
        "VEYLORA_API_KEY": "${API_PLACEHOLDER_KEY}",
        "DATABASE_URL": "file:./prisma/dev.db"
      }
    }
  }
}`;

export const API_INTRODUCTION = [
  "Every request carries `Authorization: Bearer <key>`. Keys are issued at /admin/access and the full key is shown once; only its prefix is readable afterwards.",
  `Rate limits are per key, fixed to the minute. The default is ${API_RATE_LIMIT_DEFAULT} requests per minute and the limit is stored on the key. Every response carries X-RateLimit-Limit, X-RateLimit-Remaining and X-RateLimit-Reset; exceeding it returns 429 with the same numbers.`,
  "Reads cover the owner's account. The trade scope is opt-in and places paper orders only in the dedicated agent account named by the key; it never reaches the owner's main account.",
  "An approval-required order returns 202 with a pending AgentApproval, its threshold and its expiry. The owner can read every approval and decide it at /admin/access.",
];

export const MCP_ONBOARDING = [
  "Create a key with the scopes the client needs. For an agent, create a dedicated agent account first and bind the key to it.",
  "Put the key in the MCP client's environment as VEYLORA_API_KEY. Never put it in a repository, a prompt or a shell history.",
  "Run the server from apps/web with `pnpm mcp`. It speaks MCP over stdio and opens no port.",
  "The server checks the key, its revocation and its scope on every tool call, and applies the same per-key rate limit as REST.",
  "A tool the key is not scoped for is absent from tools/list and refused if called by name.",
];
