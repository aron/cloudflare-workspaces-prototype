/**
 * E2E test harness: spawn `wrangler dev --local` once, share across tests.
 *
 * Boot is slow (~30s — docker container, miniflare setup). We keep wrangler
 * running for the whole vitest process and tear it down on shutdown.
 *
 * Tests talk to it over HTTP/WebSocket as a real browser would, so every
 * binding (Sandbox/AI/LOADER) is exercised end-to-end.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const PORT = Number(process.env.E2E_PORT ?? 8799);
export const BASE_URL = `http://127.0.0.1:${PORT}`;

let proc: ChildProcess | null = null;

/** Spawn wrangler dev with .env loaded. Resolves when the server is reachable. */
export async function startWrangler(): Promise<void> {
  if (proc) return;

  // If a previous run left a server on the port (e.g. an interactive
  // `wrangler dev` in another terminal), reuse it instead of crashing.
  if (await isUp()) return;

  const env = { ...process.env };
  try {
    const dotenv = await readFile(resolve(process.cwd(), "../../.env"), "utf8");
    for (const line of dotenv.split("\n")) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
      if (m && m[1] && !(m[1] in env)) env[m[1]] = m[2] ?? "";
    }
  } catch { /* .env optional */ }

  const args = [
    "wrangler", "dev", "--local",
    "--port", String(PORT),
    "--ip", "127.0.0.1",
    "--inspector-port", "0",
  ];
  proc = spawn("npx", args, {
    env,
    stdio:    ["ignore", "pipe", "pipe"],
    cwd:      resolve(process.cwd()),
    detached: true,  // own process group so we can SIGKILL the whole tree
  });

  const logs: string[] = [];
  proc.stdout?.on("data", chunk => logs.push(chunk.toString()));
  proc.stderr?.on("data", chunk => logs.push(chunk.toString()));

  const deadline = Date.now() + 180_000;  // cold docker build can take a while
  while (Date.now() < deadline) {
    if (!proc || proc.exitCode !== null) {
      throw new Error("wrangler exited during startup:\n" + logs.join(""));
    }
    if (await isUp()) return;
    await sleep(1000);
  }
  await stopWrangler();
  throw new Error("wrangler dev failed to come up in time\n" + logs.join(""));
}

export async function stopWrangler(): Promise<void> {
  if (!proc) return;
  const p = proc;
  proc = null;
  // Kill the whole process group — plain SIGTERM on the parent leaves the
  // workerd + docker children running.
  try { if (p.pid !== undefined) process.kill(-p.pid, "SIGTERM"); } catch { /* ignore */ }
  await new Promise(r => setTimeout(r, 500));
  try { if (p.pid !== undefined) process.kill(-p.pid, "SIGKILL"); } catch { /* ignore */ }
}

async function isUp(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/api/app/me`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch { return false; }
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// ---- request helpers ----

/** Identity header set the worker would otherwise set from Access. */
export function userHeaders(user: { userId: string; email: string; name: string }) {
  return {
    "x-user-id":    user.userId,
    "x-user-email": user.email,
    "x-user-name":  user.name,
  };
}

/**
 * Override the dev identity by setting ACCESS_DEV_USER on the spawned wrangler
 * env. Since the worker resolves identity from that var (no Access configured),
 * we can simulate different users by restarting — but for multi-user tests in
 * a single boot we need a different approach. The worker doesn't trust the
 * x-user-* headers from the client; it strips and re-attaches.
 *
 * For E2E we use a single dev user (Local Dev) and verify the wiring works
 * end-to-end. Multi-user fan-out is covered by the in-process pool-workers
 * tests where we can attach headers directly to the DO stub.
 */
