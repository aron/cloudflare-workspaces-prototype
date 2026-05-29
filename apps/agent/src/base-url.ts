/**
 * Resolve the public origin used to build absolute URLs in agent messages
 * and outgoing Google Chat notifications.
 *
 * Source precedence:
 *   1. `env.APP_BASE_URL` — static per-deploy config in `wrangler.jsonc`.
 *   2. The `x-app-base-url` header attached by the worker on every DO
 *      request. The worker derives it from `new URL(request.url).origin`,
 *      which matches whatever hostname the user actually hit.
 *   3. Empty string. Callers that need an absolute URL must check this
 *      and skip the link gracefully (don't ship a bare path).
 *
 * The header path is the fallback so a fresh deploy works without any
 * config drift; production deployments should still set `APP_BASE_URL`
 * explicitly so background jobs (cron, waitUntil after a DO eviction)
 * have a stable value when no request is in flight.
 */

export const APP_BASE_URL_HEADER = "x-app-base-url";

export interface BaseUrlEnv {
  APP_BASE_URL?: string;
}

/**
 * Pick a base URL from env first, then the request header. Trims any
 * trailing slash so callers can safely concatenate `${base}${path}`.
 */
export function resolveBaseUrl(env: BaseUrlEnv, request?: Request): string {
  const fromEnv = (env.APP_BASE_URL ?? "").trim();
  if (fromEnv) return trimTrailingSlash(fromEnv);

  const fromHeader = request?.headers.get(APP_BASE_URL_HEADER)?.trim() ?? "";
  if (fromHeader) return trimTrailingSlash(fromHeader);

  return "";
}

/**
 * Worker-side helper: attach the inferred origin to a request before
 * forwarding it to a DO stub. Strips any incoming `x-app-base-url`
 * header first so a malicious client can't spoof the value.
 */
export function withBaseUrl(request: Request, baseUrl: string): Request {
  const headers = new Headers(request.headers);
  headers.delete(APP_BASE_URL_HEADER);
  if (baseUrl) headers.set(APP_BASE_URL_HEADER, trimTrailingSlash(baseUrl));
  return new Request(request, { headers });
}

function trimTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}
