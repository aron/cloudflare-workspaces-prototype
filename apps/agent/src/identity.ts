/**
 * Identity plumbing shared between the worker entrypoint and DOs.
 *
 * Flow:
 *   1. Worker verifies the Cloudflare Access JWT (see access.ts) and produces
 *      an `AccessIdentity`. In local dev, when Access is not configured, we
 *      fall back to a dev user from `ACCESS_DEV_USER` (JSON in .dev.vars).
 *   2. Worker forwards identity to DOs as `x-user-*` request headers. DOs
 *      trust the worker — the client never sets these headers directly,
 *      and the worker strips any incoming x-user-* headers before forwarding.
 */

import { tryVerifyAccess, type AccessIdentity } from "./access.js";

export type { AccessIdentity };

export interface IdentityEnv {
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?:         string;
  /** JSON like `{"userId":"dev","email":"dev@local","name":"Dev"}`. Dev only. */
  ACCESS_DEV_USER?:    string;
}

/**
 * Resolve the caller's identity for an incoming worker request.
 *
 * Returns null when Access is configured but the JWT is missing/invalid —
 * the worker should respond 401 in that case.
 *
 * In local dev (Access not configured), returns ACCESS_DEV_USER if set,
 * otherwise a hardcoded "local" identity so `wrangler dev` keeps working.
 */
export async function resolveIdentity(
  request: Request,
  env:     IdentityEnv,
): Promise<AccessIdentity | null> {
  if (env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD) {
    return tryVerifyAccess(request, {
      teamDomain: env.ACCESS_TEAM_DOMAIN,
      aud:        env.ACCESS_AUD,
    });
  }

  if (env.ACCESS_DEV_USER) {
    try {
      const parsed = JSON.parse(env.ACCESS_DEV_USER) as Partial<AccessIdentity>;
      if (parsed.userId && parsed.email) {
        return {
          userId: parsed.userId,
          email:  parsed.email,
          name:   parsed.name ?? parsed.email.split("@")[0] ?? parsed.email,
          raw:    {},
        };
      }
    } catch { /* fall through */ }
  }

  return {
    userId: "local-user",
    email:  "local@dev",
    name:   "Local Dev",
    raw:    {},
  };
}

/** Header names the worker uses to forward identity to DOs. */
export const IDENTITY_HEADERS = {
  userId: "x-user-id",
  email:  "x-user-email",
  name:   "x-user-name",
} as const;

/**
 * Strip any incoming `x-user-*` headers from a request so a malicious client
 * can't forge identity, then attach the worker-resolved identity. Returns a
 * new Request safe to forward to a DO.
 */
export function withIdentity(request: Request, identity: AccessIdentity): Request {
  const headers = new Headers(request.headers);
  for (const h of Object.values(IDENTITY_HEADERS)) headers.delete(h);
  headers.set(IDENTITY_HEADERS.userId, identity.userId);
  headers.set(IDENTITY_HEADERS.email,  identity.email);
  headers.set(IDENTITY_HEADERS.name,   identity.name);
  return new Request(request, { headers });
}

/**
 * Read the identity headers inside a DO. Returns null if missing — callers
 * should respond 401. DOs should only ever be reached through the worker,
 * which always attaches identity.
 */
export function readIdentity(
  request: Request,
): { userId: string; email: string; name: string } | null {
  const userId = request.headers.get(IDENTITY_HEADERS.userId);
  const email  = request.headers.get(IDENTITY_HEADERS.email);
  const name   = request.headers.get(IDENTITY_HEADERS.name);
  if (!userId || !email || !name) return null;
  return { userId, email, name };
}

/**
 * Convenience: read identity or return a 401 Response. Lets callers do:
 *   const id = requireIdentity(req); if (id instanceof Response) return id;
 */
export function requireIdentity(request: Request):
  | { userId: string; email: string; name: string }
  | Response
{
  const id = readIdentity(request);
  if (!id) return new Response("missing identity headers", { status: 401 });
  return id;
}
