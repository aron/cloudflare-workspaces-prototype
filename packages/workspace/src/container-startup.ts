/**
 * Boot-time orchestration for the container-side `workspace-server` process.
 *
 * Pulled out of `Workspace` so the failure-mode logic can be exercised by
 * unit tests against a fake sandbox stub. See `tests/container-startup.test.ts`
 * for the scenarios this file is designed to handle.
 */

import type { Process, Sandbox } from "@cloudflare/sandbox";
// switchPort intentionally not imported — we pass the port to containerFetch's
// second arg instead of via the cf-container-target-port header. See probePort.

/**
 * Minimal surface of `@cloudflare/sandbox`'s `Sandbox` DO stub that we use.
 * Defined as a structural interface so tests can pass a hand-rolled fake.
 */
export interface SandboxLike {
  getProcess(id: string): Promise<Process | null>;
  startProcess(command: string, options?: { processId?: string }): Promise<Process>;
  containerFetch(request: Request, port?: number): Promise<Response>;
}

export const WORKSPACE_SERVER_PROCESS_ID = "workspace-server";
export const WORKSPACE_SERVER_COMMAND = "node /app/server.cjs";

/**
 * Return the workspace-server process record only if it's actually alive.
 *
 * Critical for correctness: the SDK's `getProcess` returns a record even for
 * `failed` / `killed` / `completed` / `error` processes. Treating any of
 * those as "alive" makes a subsequent `waitForPort` call reject immediately
 * with `ProcessExitedBeforeReadyError`, even when the real server is
 * happily serving the port (e.g. because a concurrent starter lost the race
 * and clobbered the SDK's record with its own EADDRINUSE failure).
 */
export async function findRunningServer(sb: SandboxLike): Promise<Process | null> {
  let rec: Process | null = null;
  try { rec = await sb.getProcess(WORKSPACE_SERVER_PROCESS_ID); } catch { /* not present */ }
  if (!rec) return null;
  return rec.status === "running" || rec.status === "starting" ? rec : null;
}

/**
 * Default total wall-clock budget for retrying a 503 from `probePort`,
 * in ms. Matches the Cloudflare sandbox SDK's `DEFAULT_RETRY_TIMEOUT_MS`
 * so the warm-up gate has the same patience as the SDK's own transport.
 */
const DEFAULT_PROBE_RETRY_TIMEOUT_MS = 90_000;
/** Cap per backoff sleep — same curve the SDK uses internally. */
const MAX_PROBE_BACKOFF_MS = 30_000;
const BASE_PROBE_BACKOFF_MS = 3_000;
/** Floor on remaining budget; below this, stop retrying. */
const MIN_PROBE_REMAINING_MS = 500;

/**
 * HTTP GET on the workspace-server port. Returns true iff something answers
 * with a 2xx/3xx — which means a `workspace-server` is up regardless of what
 * the SDK's process table says.
 *
 * 503 handling: `Container.containerFetch` returns 503 when the underlying
 * workerd instance is still starting, is being replaced, or the account is
 * briefly out of instance slots. The SDK retries 503 internally for its
 * *own* transport calls (BaseTransport.fetch, ContainerControlClient) but
 * not for direct `containerFetch` callers like us — so a single 503 here
 * used to fall through into `startProcess`, which would also get 503, and
 * the failure surfaced downstream as `WebSocket upgrade failed: 503`. We
 * mirror the SDK's curve (3s → 30s exponential, 90s total) so the warm-up
 * gate actually waits for the container to be available before declaring
 * the server down.
 *
 * Non-503 errors return `false` on the first attempt: those are honest
 * “port isn't bound” signals that mean the caller should go start the
 * workspace-server.
 */
export async function probePort(
  sb: SandboxLike,
  port: number,
  options: { retryTimeoutMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<boolean> {
  const retryTimeoutMs = options.retryTimeoutMs ?? DEFAULT_PROBE_RETRY_TIMEOUT_MS;
  const sleep = options.sleep ?? defaultProbeSleep;
  const now = options.now ?? Date.now;
  const startedAt = now();
  let attempt = 0;
  while (true) {
    try {
      const req = new Request("http://container/", { method: "GET" });
      // `containerFetch` only reads the port from the second arg — the
      // `cf-container-target-port` header set by `switchPort` is read by
      // `Container.fetch` but NOT by `containerFetch`. Passing the port
      // explicitly avoids a false-positive probe that lands on `defaultPort`
      // (3000) and gets back the sandbox control-plane's "Hello from Bun"
      // response, making us skip starting workspace-server entirely.
      const res = await sb.containerFetch(req, port);
      if (res.ok) return true;
      if (res.status !== 503) return false;
      // 503 — fall through to backoff/retry.
    } catch {
      // A thrown exception from containerFetch is not the “no instance”
      // case (those come back as a Response with status 503); it's e.g.
      // a DO eviction mid-call. Treat it the same as “port not up” —
      // surface false so the caller proceeds to startProcess.
      return false;
    }
    const elapsed = now() - startedAt;
    const remaining = retryTimeoutMs - elapsed;
    if (remaining <= MIN_PROBE_REMAINING_MS) return false;
    const delay = Math.min(BASE_PROBE_BACKOFF_MS * 2 ** attempt, MAX_PROBE_BACKOFF_MS);
    const sleepMs = Math.min(delay, Math.max(0, remaining - MIN_PROBE_REMAINING_MS));
    await sleep(sleepMs);
    attempt++;
  }
}

function defaultProbeSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Make sure `workspace-server` is running and listening on `port`.
 *
 * Defends against three failure modes that all surfaced as the same
 * `ProcessExitedBeforeReadyError` in production:
 *
 *   1. **Stale `failed` process record.** `getProcess` returns a record
 *      even for terminated processes; the naive `if (!proc) start()` check
 *      treats that as "process exists" and goes straight to `waitForPort`,
 *      which immediately rejects because the record says `exitCode: 1`.
 *      We only reuse `running` / `starting` records.
 *
 *   2. **Concurrent warmup race.** Two callers can both pass `getProcess`
 *      and both invoke `startProcess`. The second spawn dies with
 *      EADDRINUSE on the port — silently, since the server logs to a file —
 *      and clobbers the SDK's process record with `status: failed`, even
 *      though the winner is still serving the port. Memoising the
 *      in-flight promise in the caller (see `Workspace.ensureContainerProcess`)
 *      removes the race; the probe-after-failure logic here recovers
 *      regardless.
 *
 *   3. **Server already up, no SDK record.** After a DO restart the
 *      Workspace is fresh but the container kept the workspace-server alive
 *      across the gap. Probing the port lets us reuse it without spawning a
 *      doomed duplicate.
 */
export interface EnsureWorkspaceServerOptions {
  /**
   * Forwarded to every `probePort` call so a single retry budget covers
   * the entire warm-up path. Tests pass `{ retryTimeoutMs: 0 }` so 503
   * is treated as “port down” immediately.
   */
  probe?: { retryTimeoutMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number };
}

export async function ensureWorkspaceServer(
  sb: SandboxLike,
  port: number,
  options: EnsureWorkspaceServerOptions = {},
): Promise<void> {
  const probeOpts = options.probe;
  // 1. Fast path: server may already be up from a previous run.
  if (await probePort(sb, port, probeOpts)) return;

  // 2. Reuse an existing live record if there is one.
  const existing = await findRunningServer(sb);
  if (existing) {
    try {
      await existing.waitForPort(port);
      return;
    } catch {
      // Record claimed running but the port never came up. Re-probe;
      // otherwise fall through to startProcess.
      if (await probePort(sb, port, probeOpts)) return;
    }
  }

  // 3. Start a fresh server.
  let proc: Process;
  try {
    proc = await sb.startProcess(WORKSPACE_SERVER_COMMAND, { processId: WORKSPACE_SERVER_PROCESS_ID });
  } catch {
    // Some SDK versions reject when a process with the same id already
    // exists in a non-terminal state. Probe — if the port is up, we're done.
    if (await probePort(sb, port, probeOpts)) return;
    throw new Error("workspace-server: startProcess failed and port is not up");
  }
  try {
    await proc.waitForPort(port);
  } catch (err) {
    // Common race: we lost to a concurrent starter, our spawn died with
    // EADDRINUSE. The winner is still serving the port.
    if (await probePort(sb, port, probeOpts)) return;
    throw err;
  }
}
