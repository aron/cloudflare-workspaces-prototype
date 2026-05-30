/**
 * Thin wrapper over the `cloudflare:workers` `tracing` API (private beta).
 *
 * Why a wrapper:
 *
 *   - The runtime binding for `tracing` is gated behind a beta flag; without
 *     it, importing `tracing` from `cloudflare:workers` would throw at module
 *     load time on some runtime builds. We feature-detect via `try/catch`
 *     around a dynamic `await import("cloudflare:workers")` so call sites can
 *     opt in unconditionally without breaking unflagged environments,
 *     unit tests, or the host-toolchain agent-suite.
 *
 *   - `Span.setAttribute` only does work when the span is actually being
 *     collected. The `set(key, () => value)` lazy form lets callers attach
 *     expensive attributes (stringified command lines, file paths after
 *     redaction) without paying the cost on every call when tracing is off.
 *
 *   - Centralising attribute key formation (`hackspace.*`) and secret
 *     redaction here keeps both consistent across every call site so
 *     dashboards see one schema.
 *
 * Tracing is opt-in per environment. When unavailable, `trace()` runs the
 * callback directly and `setError()` / `set()` are no-ops; the wrapper is
 * zero-overhead beyond one boolean check on the cached availability flag.
 */

// -----------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------

/**
 * A span handle passed to the `trace` callback. Wraps the runtime's `Span`
 * so callers don't need to defensively check `isTraced` at every call.
 */
export interface TraceSpan {
  /**
   * Attach a structured attribute to the span. The value is computed
   * lazily: when tracing is disabled (or the span is not being collected),
   * the producer thunk is never called. Use for any attribute whose value
   * costs more than a property read — JSON.stringify, regex matches,
   * redaction, etc.
   */
  set(key: string, value: () => string | number | boolean | undefined): void;
  /**
   * Record an error on the span. Sets `hackspace.error_kind` (one of
   * `"timeout" | "503" | "abort" | "other"`) and `hackspace.error` (the
   * truncated message). Idempotent — repeat calls overwrite.
   */
  setError(err: unknown): void;
}

/**
 * Run `fn` inside a span named `name`. The span ends when the promise
 * settles (success or rejection). On rejection, `setError` is called
 * automatically before re-throwing.
 *
 * `attrs` is a record of cheap eager attributes set before `fn` runs.
 * Use the lazy `span.set(...)` form inside the callback for anything
 * that depends on the result.
 *
 * Returns whatever `fn` returns. Always awaits, even for synchronous
 * callbacks, so callers can use a single `await` regardless of whether
 * tracing is enabled — keeps the contract stable.
 */
export async function trace<T>(
  name: string,
  attrs: Record<string, string | number | boolean | undefined>,
  fn: (span: TraceSpan) => Promise<T> | T,
): Promise<T> {
  const t = await getTracing();
  if (!t) {
    // Tracing not available — run inline with a no-op span so call sites
    // that use `span.set(...)` inside the callback don't NPE.
    return await fn(NOOP_SPAN);
  }
  return t.enterSpan(name, async (runtimeSpan) => {
    const span = wrapSpan(runtimeSpan);
    for (const [k, v] of Object.entries(attrs)) {
      if (v !== undefined) runtimeSpan.setAttribute(k, v);
    }
    try {
      return await fn(span);
    } catch (err) {
      span.setError(err);
      throw err;
    }
  });
}

/**
 * Strip well-known secrets out of a URL/string before attaching it to
 * a span attribute.
 *
 *   - Cloudflare Artifacts URLs: `https://x:art_v1_...@host/...`
 *     → `https://x:REDACTED@host/...`
 *   - Google Chat webhook query string: `?key=...&token=...`
 *     → `?key=REDACTED&token=REDACTED`
 *
 * Anything else passes through unchanged. Exposed for use in span
 * attribute producers that want to emit URLs without leaking tokens
 * into trace storage.
 */
export function redactSecrets(s: string): string {
  return s
    // userinfo in URLs — covers `x:art_v1_...@`, `user:pass@`, etc.
    // Keep the host so dashboards can still group by service.
    .replace(/(https?:\/\/[^/\s@]*:)[^@\s]+(@)/g, "$1REDACTED$2")
    // `key` and `token` query params, case-insensitive.
    .replace(/([?&](?:key|token|access_token|signature)=)[^&\s#]+/gi, "$1REDACTED");
}

/**
 * Classify an arbitrary error into one of the buckets dashboards group on.
 * Exposed so call sites can override the auto-classification when they
 * have more context (e.g. an HTTP response object instead of a stringy
 * error message).
 */
export function classifyError(err: unknown): "timeout" | "503" | "abort" | "other" {
  const msg = err instanceof Error ? err.message : String(err);
  if (/aborted|AbortError/i.test(msg)) return "abort";
  if (/\b503\b|Service Unavailable/i.test(msg)) return "503";
  if (/timeout|timed out|ETIMEDOUT/i.test(msg)) return "timeout";
  return "other";
}

// -----------------------------------------------------------------------
// Internals
// -----------------------------------------------------------------------

/**
 * Minimal shape of the runtime `Tracing` interface — declared locally so
 * this module compiles in environments where the workers-types entry that
 * declares `tracing` isn't on the typeroot (e.g. the test runner).
 *
 * Keep in sync with the real `cloudflare:workers` declaration:
 *   interface Tracing {
 *     enterSpan<T, A extends unknown[]>(
 *       name: string,
 *       callback: (span: Span, ...args: A) => T,
 *       ...args: A
 *     ): T;
 *     Span: typeof Span;
 *   }
 *   declare abstract class Span {
 *     get isTraced(): boolean;
 *     setAttribute(key: string, value?: boolean | number | string): void;
 *   }
 */
interface RuntimeSpan {
  readonly isTraced: boolean;
  setAttribute(key: string, value?: boolean | number | string): void;
}
interface RuntimeTracing {
  enterSpan<T>(name: string, callback: (span: RuntimeSpan) => T): T;
}

/** Cached availability of the `cloudflare:workers` `tracing` export. */
let cached: RuntimeTracing | null | undefined;

/**
 * Resolve the runtime tracing binding once per process. The cache holds
 * either a usable tracing object, or `null` if the import / binding is
 * missing. We never re-attempt — if the runtime doesn't have it at
 * startup, polling won't make it appear.
 *
 * Exported as `__resetTracingCacheForTesting` so unit tests can install
 * a fake module loader and re-resolve. Not part of the public API.
 */
async function getTracing(): Promise<RuntimeTracing | null> {
  if (cached !== undefined) return cached;
  try {
    // `cloudflare:workers` is unresolvable in node test environments, so
    // the dynamic import + `as unknown` cast keeps the type-check happy
    // without leaking a hard import declaration into the module graph.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = await (Function("return import('cloudflare:workers')")() as Promise<any>);
    if (mod && typeof mod.tracing?.enterSpan === "function") {
      cached = mod.tracing as RuntimeTracing;
      return cached;
    }
    cached = null;
    return null;
  } catch {
    cached = null;
    return null;
  }
}

export function __resetTracingCacheForTesting(): void {
  cached = undefined;
}

/** No-op span used when tracing isn't available. */
const NOOP_SPAN: TraceSpan = {
  set() { /* no-op */ },
  setError() { /* no-op */ },
};

/**
 * Adapt a `RuntimeSpan` (from the workers runtime) into the public
 * `TraceSpan` shape with lazy attribute setting and structured error
 * reporting. The cheap `isTraced` check guards every attribute write so
 * `set()`'s callback never runs when the span is dropped.
 */
function wrapSpan(runtime: RuntimeSpan): TraceSpan {
  return {
    set(key, produce) {
      if (!runtime.isTraced) return;
      const value = produce();
      if (value === undefined) return;
      runtime.setAttribute(key, value);
    },
    setError(err) {
      if (!runtime.isTraced) return;
      const kind = classifyError(err);
      const msg = err instanceof Error ? err.message : String(err);
      // 512 char cap matches the OpenTelemetry recommendation for
      // `exception.message`; long stack traces never belong in attribute
      // storage, only in logs.
      runtime.setAttribute("hackspace.error_kind", kind);
      runtime.setAttribute("hackspace.error", msg.slice(0, 512));
    },
  };
}
