import { ApiProblem, ApiResult, isRecord } from "@/lib/api/problem";
import type { ApiPrincipal } from "@/lib/api/auth";
import { scopeRefusal } from "@/lib/api/auth";
import { API_ROUTES, type ApiField, type ApiRouteSpec } from "@/lib/api/routes";

/**
 * MCP tools, derived from the REST routes (phase 32).
 *
 * A tool is not a second implementation: each one names a route in {@link API_ROUTES},
 * exposes that route's query or body fields as its JSON schema, and calls the route's own
 * handler. The service layer, validation and refusal codes are therefore identical on both
 * surfaces, and a new route becomes a tool by adding its name here.
 *
 * The scope is the route's scope. `tools/list` withholds a tool the key cannot use, and
 * {@link invokeApiTool} checks again by name — a client that calls a hidden tool is refused
 * with the same SCOPE_REQUIRED answer REST gives.
 */

export type ApiTool = {
  name: string;
  description: string;
  scope: ApiRouteSpec["scope"];
  route: ApiRouteSpec;
  inputSchema: {
    type: "object";
    properties: Record<string, { type: string; description: string }>;
    required: string[];
    additionalProperties: false;
  };
};

const TOOL_BY_ROUTE: Record<string, string> = {
  "GET /account": "get_account",
  "GET /balances": "get_balances",
  "GET /portfolio": "get_portfolio",
  "GET /positions": "get_positions",
  "GET /ledger": "get_ledger",
  "GET /orders": "get_orders",
  "GET /strategies": "get_strategies",
  "GET /alerts": "get_alerts",
  "GET /market-data": "get_market_data",
  "GET /agent": "get_agent_account",
  "GET /approvals": "get_approvals",
  "POST /orders": "place_agent_order",
};

function jsonType(field: ApiField): string {
  if (field.type === "integer") return "integer";
  if (field.type === "number") return "number";
  return "string";
}

function schemaFor(route: ApiRouteSpec): ApiTool["inputSchema"] {
  const fields = route.method === "POST" ? route.body ?? [] : route.query;
  const properties: Record<string, { type: string; description: string }> = {};
  const required: string[] = [];
  for (const field of fields) {
    properties[field.name] = { type: jsonType(field), description: field.description };
    if (field.required) required.push(field.name);
  }
  return { type: "object", properties, required, additionalProperties: false };
}

export const API_TOOLS: readonly ApiTool[] = API_ROUTES.map((route) => {
  const name = TOOL_BY_ROUTE[`${route.method} ${route.path}`];
  if (!name) throw new Error(`Route ${route.method} ${route.path} has no MCP tool name.`);
  return {
    name,
    description: `${route.summary}. ${route.description}`,
    scope: route.scope,
    route,
    inputSchema: schemaFor(route),
  };
});

export function findApiTool(name: string): ApiTool | null {
  return API_TOOLS.find((tool) => tool.name === name) ?? null;
}

export function toolsForScopes(scopes: readonly string[]): ApiTool[] {
  return API_TOOLS.filter((tool) => scopes.includes(tool.scope));
}

function checkArgs(tool: ApiTool, args: Record<string, unknown>): void {
  const allowed = new Set(Object.keys(tool.inputSchema.properties));
  const unknown = Object.keys(args).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new ApiProblem(400, "TOOL_ARGUMENT_UNKNOWN", `${tool.name} does not accept: ${unknown.join(", ")}.`);
  }
  const missing = tool.inputSchema.required.filter((key) => args[key] === undefined || args[key] === null || args[key] === "");
  if (missing.length > 0) {
    throw new ApiProblem(400, "TOOL_ARGUMENT_REQUIRED", `${tool.name} requires: ${missing.join(", ")}.`);
  }
  for (const [key, value] of Object.entries(args)) {
    const type = tool.inputSchema.properties[key]?.type;
    if (type === "integer" && !(typeof value === "number" && Number.isInteger(value))) {
      throw new ApiProblem(400, "TOOL_ARGUMENT_INVALID", `${key} must be an integer.`);
    }
    if (type === "string" && typeof value !== "string") {
      throw new ApiProblem(400, "TOOL_ARGUMENT_INVALID", `${key} must be a string.`);
    }
  }
}

export async function invokeApiTool(input: {
  name: string;
  args: unknown;
  principal: ApiPrincipal;
  now?: Date;
}): Promise<unknown> {
  const tool = findApiTool(input.name);
  if (!tool) {
    throw new ApiProblem(
      404,
      "TOOL_NOT_FOUND",
      `No tool named ${input.name}. Call tools/list to see the tools this key can use.`,
    );
  }
  const denial = scopeRefusal(input.principal, tool.scope);
  if (denial) throw new ApiProblem(denial.status, denial.code, denial.message, { requiredScope: tool.scope });

  if (input.args !== undefined && !isRecord(input.args)) {
    throw new ApiProblem(400, "TOOL_ARGUMENT_INVALID", "Tool arguments must be a JSON object.");
  }
  const args = (input.args ?? {}) as Record<string, unknown>;
  checkArgs(tool, args);

  const query = new URLSearchParams();
  if (tool.route.method === "GET") {
    for (const [key, value] of Object.entries(args)) {
      if (value === undefined || value === null) continue;
      query.set(key, String(value));
    }
  }

  const result = await tool.route.handler({
    principal: input.principal,
    query,
    body: tool.route.method === "POST" ? args : null,
    request: new Request(`http://localhost/api/v1${tool.route.path}${query.size > 0 ? `?${query}` : ""}`),
    now: input.now ?? new Date(),
  });
  // A handler's 202 (an approval was created) is still a successful tool result: the
  // body is what the agent needs, and the status is carried inside it.
  return result instanceof ApiResult ? result.body : result;
}
