/**
 * Boot-time orchestration for the container-side `workspace-server` process.
 *
 * Pulled out of `Workspace` so the failure-mode logic can be exercised by
 * unit tests against a fake sandbox stub. See `tests/container-startup.test.ts`
 * for the scenarios this file is designed to handle.
 */

import type { Process, Sandbox } from "@cloudflare/sandbox";
import { switchPort } from "@cloudflare/containers";

/**
 * Minimal surface of `@cloudflare/sandbox`'s `Sandbox` DO stub that we use.
 * Defined as a structural interface so tests can pass a hand-rolled fake.
 */
export interface SandboxLike {
  getProcess(id: string): Promise<Process | null>;
  startProcess(command: string, options?: { processId?: string }): Promise<Process>;
  containerFetch(request: Request): Promise<Response>;
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
 * HTTP GET on the workspace-server port. Returns true iff something answers
 * with a 2xx/3xx — which means a `workspace-server` is up regardless of what
 * the SDK's process table says.
 */
export async function probePort(sb: SandboxLike, port: number): Promise<boolean> {
  try {
    const req = new Request("http://container/", { method: "GET" });
    const res = await sb.containerFetch(switchPort(req, port));
    return res.ok;
  } catch {
    return false;
  }
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
export async function ensureWorkspaceServer(sb: SandboxLike, port: number): Promise<void> {
  // 1. Fast path: server may already be up from a previous run.
  if (await probePort(sb, port)) return;

  // 2. Reuse an existing live record if there is one.
  const existing = await findRunningServer(sb);
  if (existing) {
    try {
      await existing.waitForPort(port);
      return;
    } catch {
      // Record claimed running but the port never came up. Re-probe;
      // otherwise fall through to startProcess.
      if (await probePort(sb, port)) return;
    }
  }

  // 3. Start a fresh server.
  let proc: Process;
  try {
    proc = await sb.startProcess(WORKSPACE_SERVER_COMMAND, { processId: WORKSPACE_SERVER_PROCESS_ID });
  } catch {
    // Some SDK versions reject when a process with the same id already
    // exists in a non-terminal state. Probe — if the port is up, we're done.
    if (await probePort(sb, port)) return;
    throw new Error("workspace-server: startProcess failed and port is not up");
  }
  try {
    await proc.waitForPort(port);
  } catch (err) {
    // Common race: we lost to a concurrent starter, our spawn died with
    // EADDRINUSE. The winner is still serving the port.
    if (await probePort(sb, port)) return;
    throw err;
  }
}
