/**
 * Cloudflare Access JWT verification.
 *
 * Wraps every incoming request: if the Cf-Access-Jwt-Assertion header is
 * missing or fails JWKS verification, the request is rejected. Successful
 * verification yields { email, sub } that the worker can use for scoping.
 *
 * Docs: https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/
 */

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

export interface AccessIdentity {
  email: string;
  sub:   string;          // unique user id from the IdP
  raw:   JWTPayload;      // full claims, useful for debugging
}

export interface AccessConfig {
  /** Your Access team domain, e.g. "yourteam.cloudflareaccess.com". */
  teamDomain: string;
  /** The Application AUD tag from the Access app settings. */
  aud:        string;
}

let cachedJwks: ReturnType<typeof createRemoteJWKSet> | null = null;
let cachedJwksTeam: string | null = null;

function jwks(teamDomain: string) {
  if (cachedJwks && cachedJwksTeam === teamDomain) return cachedJwks;
  cachedJwks = createRemoteJWKSet(
    new URL(`https://${teamDomain}/cdn-cgi/access/certs`),
  );
  cachedJwksTeam = teamDomain;
  return cachedJwks;
}

/**
 * Verify the Access JWT on a request. Returns the identity on success;
 * throws on any failure (missing header, bad signature, wrong aud, expired).
 */
export async function verifyAccessJwt(
  request: Request,
  cfg:     AccessConfig,
): Promise<AccessIdentity> {
  // Most requests land here with the JWT in Cf-Access-Jwt-Assertion (the
  // Access edge injects it from the CF_Authorization cookie). WebSocket
  // upgrades, EventSource, and a few other request shapes don't get the
  // header but DO carry the cookie, so we fall back to reading it.
  const token =
    request.headers.get("Cf-Access-Jwt-Assertion") ??
    readCookie(request.headers.get("cookie"), "CF_Authorization");
  if (!token) throw new Error("missing Cf-Access-Jwt-Assertion header / CF_Authorization cookie");

  const { payload } = await jwtVerify(token, jwks(cfg.teamDomain), {
    issuer:   `https://${cfg.teamDomain}`,
    audience: cfg.aud,
  });

  const email = (payload.email ?? payload["custom:email"]) as string | undefined;
  if (!email) throw new Error("Access JWT has no email claim");

  return { email, sub: payload.sub ?? "unknown", raw: payload };
}

/** Convenience: returns null on failure instead of throwing. */
export async function tryVerifyAccess(
  request: Request,
  cfg:     AccessConfig,
): Promise<AccessIdentity | null> {
  try { return await verifyAccessJwt(request, cfg); }
  catch { return null; }
}

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    if (part.slice(0, eq) === name) return decodeURIComponent(part.slice(eq + 1));
  }
  return null;
}
