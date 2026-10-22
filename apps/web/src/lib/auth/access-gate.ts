import { getAuthConfig, getAuthUnavailableReason } from "@/lib/auth/config";
import {
  AuthenticationRequiredError,
  AuthorizationRequiredError,
  StepUpRequiredError,
  getCurrentUser,
  requireAdmin,
  requireSitePermission,
  requireUser,
} from "@/lib/auth/session-store";
import type { SitePermissionKey } from "@/lib/auth/access-control";

/**
 * One place answers two questions that used to be copy-pasted into every owner
 * page and route: may this caller use it, and when the deployment cannot
 * authenticate anyone at all, what exactly does the refusal say?
 *
 * The distinction matters. A *visitor without a session* is asked to sign in,
 * because sign-in works here. A *deployment with no usable authentication
 * configuration* is a configuration gap: it answers 503 naming the missing
 * variable, in the same words the page shows, so the owner learns what to set
 * instead of chasing a sign-in that can never complete.
 */

const GAP_REJECTED = "Authentication configuration is rejected.";

/** The missing configuration name, or null when sign-in is usable. */
export function getAuthenticationGap(): string | null {
  if (getAuthConfig()) return null;
  return getAuthUnavailableReason() ?? GAP_REJECTED;
}

/** The single wording for "this deployment cannot authenticate anyone yet". */
export function authenticationGapMessage(gap: string = getAuthenticationGap() ?? GAP_REJECTED): string {
  return `Authentication is not configured: ${gap}`;
}

/**
 * A route's unconfigured answer: HTTP 503 whose body names what is missing.
 *
 * Self-contained on purpose. Every route's own `json` helper already sends
 * `Cache-Control: no-store`, so this response is identical to what the route
 * would have built, and no route has to adapt a helper signature to use it.
 */
export function authenticationGapResponse(): Response {
  return Response.json({ error: authenticationGapMessage() }, {
    status: 503,
    headers: { "Cache-Control": "no-store" },
  });
}

export type AccessRefusal = {
  status: 401 | 403 | 428 | 503;
  error: string;
  /** Present on a step-up refusal: what the code being asked for would prove. */
  code?: "TOTP_REQUIRED";
  scope?: string;
  /** Present on a permission refusal: the exact key the account is missing. */
  permissionKey?: SitePermissionKey;
};

/**
 * Turn an authentication or authorization failure into its honest refusal.
 * Returns null for anything else, so a route keeps its own error handling for
 * the failures this gate does not own.
 *
 * Three different situations, three different answers, because they ask three
 * different things of the caller: sign in (401, or 503 when this deployment
 * cannot sign anyone in at all), your account may not do this (403), and your
 * account may do this but has to prove a code first (428, carrying the scope so
 * one prompt in the client can serve every gated surface).
 */
export function getAccessRefusal(error: unknown): AccessRefusal | null {
  if (error instanceof AuthenticationRequiredError) {
    const gap = getAuthenticationGap();
    return gap
      ? { status: 503, error: authenticationGapMessage(gap) }
      : { status: 401, error: "Authentication required." };
  }
  if (error instanceof AuthorizationRequiredError) {
    return {
      status: 403,
      error: error.message,
      ...(error.permissionKey ? { permissionKey: error.permissionKey } : {}),
    };
  }
  if (error instanceof StepUpRequiredError) {
    return { status: 428, error: error.message, code: "TOTP_REQUIRED", scope: error.scope };
  }
  return null;
}

/**
 * The body of a refusal, as every route should send it.
 *
 * One function so a permission refusal carries the same fields wherever it is
 * answered: the sentence (which names the permission), and the key itself for a
 * client that wants to react to it. A route that hand-rolled `{ error }` would
 * answer the right status with less than half the information.
 */
export function accessRefusalPayload(refusal: AccessRefusal): Record<string, unknown> {
  return {
    error: refusal.error,
    ...(refusal.permissionKey ? { permissionKey: refusal.permissionKey } : {}),
    ...(refusal.code ? { code: refusal.code } : {}),
    ...(refusal.scope ? { scope: refusal.scope } : {}),
  };
}

export type PageAccessRequirement =
  | { kind: "user" }
  | { kind: "admin" }
  | { kind: "permission"; permissionKey: SitePermissionKey };

export type PageAccess =
  | { status: "granted"; user: NonNullable<Awaited<ReturnType<typeof getCurrentUser>>> }
  | { status: "unconfigured"; reason: string }
  | { status: "anonymous" }
  | { status: "forbidden"; reason: string; permissionKey?: SitePermissionKey };

/**
 * The page half of the same rule. A page never throws its refusal at the
 * visitor: it renders, and says either "sign in" or "this deployment cannot sign
 * anyone in, and here is the name that is missing".
 */
export async function checkPageAccess(requirement: PageAccessRequirement): Promise<PageAccess> {
  const gap = getAuthenticationGap();
  if (gap) return { status: "unconfigured", reason: gap };

  try {
    const user = requirement.kind === "admin"
      ? await requireAdmin()
      : requirement.kind === "permission"
        ? await requireSitePermission(requirement.permissionKey)
        : await requireUser();
    return { status: "granted", user };
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) return { status: "anonymous" };
    if (error instanceof AuthorizationRequiredError) {
      return {
        status: "forbidden",
        reason: error.message,
        ...(error.permissionKey ? { permissionKey: error.permissionKey } : {}),
      };
    }
    throw error;
  }
}
