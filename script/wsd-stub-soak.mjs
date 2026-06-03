#!/usr/bin/env node

// wsd-stub-soak.mjs — soak the long-lived WebSocket session against a
// running wsd and sample the per-class live-stub counters exposed at
// GET /__wsd/stubs.
//
// The goal is leak discovery, not load testing: at a quiet point
// after the workload finishes, every counter that isn't a root
// session target should be zero. Anything non-zero is a leak we
// need to plug before shipping long-lived sessions to production.
//
// Workload (defaults — override via env):
//
//   SOAK_SYNC_TICKS    number of pullOnce calls    (default 50)
//   SOAK_EXEC_CALLS    number of shell.exec calls  (default 100)
//   SOAK_FETCH_CALLS   number of fetchChanges-only calls (default 50)
//   SOAK_QUIET_MS      idle window before final sample    (default 500)
//
// Knobs you usually leave alone:
//
//   WSD_BINARY         path to the wsd CLI (default: package dist)
//
// Output is human-readable on stderr (progress + final table) and a
// JSON summary on stdout, suitable for piping into jq.

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

import { createWorkspaceClient } from "@cloudflare/workspace-rpc/client";
import { pullOnce } from "@cloudflare/workspace-rpc/driver";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

const WSD_BINARY =
  process.env.WSD_BINARY ?? join(REPO_ROOT, "packages/wsd/dist/cli/wsd.cjs");

const SYNC_TICKS = Number(process.env.SOAK_SYNC_TICKS ?? "50");
const EXEC_CALLS = Number(process.env.SOAK_EXEC_CALLS ?? "100");
const FETCH_CALLS = Number(process.env.SOAK_FETCH_CALLS ?? "50");
const QUIET_MS = Number(process.env.SOAK_QUIET_MS ?? "500");

// ───────────────────────────────────────────────────────────────────
// Helpers

function getAvailablePort() {
  return new Promise((resolveP, rejectP) => {
    const s = createServer();
    s.once("error", rejectP);
    s.listen(0, "127.0.0.1", () => {
      const port = s.address().port;
      s.close((err) => (err ? rejectP(err) : resolveP(port)));
    });
  });
}

function httpGet(url) {
  return new Promise((resolveP, rejectP) => {
    const req = request(url, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => {
        body += c;
      });
      res.on("end", () =>
        resolveP({ statusCode: res.statusCode ?? 0, body }),
      );
    });
    req.once("error", rejectP);
    req.end();
  });
}

async function waitForHealth(port, child, deadlineMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < deadlineMs) {
    if (child.exitCode !== null) {
      throw new Error(`wsd exited early with code ${child.exitCode}`);
    }
    try {
      const r = await httpGet(`http://127.0.0.1:${port}/health`);
      if (r.statusCode === 200) return;
    } catch {
      // not up yet
    }
    await sleep(50);
  }
  throw new Error("wsd never reported healthy");
}

async function snapshot(port) {
  const r = await httpGet(`http://127.0.0.1:${port}/__wsd/stubs`);
  if (r.statusCode !== 200) {
    throw new Error(
      `/__wsd/stubs returned ${r.statusCode}: ${r.body.slice(0, 200)}`,
    );
  }
  return JSON.parse(r.body);
}

function diff(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out = {};
  for (const k of keys) out[k] = (b[k] ?? 0) - (a[k] ?? 0);
  return out;
}

// ───────────────────────────────────────────────────────────────────
// Main

async function main() {
  const port = await getAvailablePort();
  const mountPoint = await mkdtemp(join(tmpdir(), "wsd-stub-soak-"));

  const env = {
    ...process.env,
    MOUNT_POINT: mountPoint,
    PORT: String(port),
    DISABLE_FUSE: "1",
    CAPNWEB_TRACK_STUBS: "1",
  };

  console.error(`[soak] starting wsd on :${port} (mount=${mountPoint})`);
  const child = spawn(WSD_BINARY, {
    cwd: REPO_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderrBuf = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (c) => {
    stderrBuf += c;
  });
  child.stdout.resume();

  const cleanup = async () => {
    try {
      child.kill("SIGTERM");
      await sleep(150);
      if (child.exitCode === null) child.kill("SIGKILL");
    } catch {}
    await rm(mountPoint, { recursive: true, force: true });
  };

  try {
    await waitForHealth(port, child);
    console.error("[soak] wsd healthy");

    // Baseline before any client work. The server-side composite +
    // sync + shell RpcTargets are created on first ws session, so
    // this should be empty.
    const baseline = await snapshot(port);
    console.error("[soak] baseline:", JSON.stringify(baseline));

    const client = createWorkspaceClient({ url: `ws://127.0.0.1:${port}/ws` });

    // After the WS handshake settles, the server should have a
    // SyncRPCServer + ShellRPCServer + WorkspaceRPCServer alive
    // (the root targets capnweb holds for the session).
    await client.sync.watermarks();
    await sleep(50);
    const afterConnect = await snapshot(port);
    console.error("[soak] after-connect:", JSON.stringify(afterConnect));

    // Sync ticks. pullOnce calls fetchChanges + fetchObjects each
    // tick. The result envelopes are exactly what we suspect leak.
    console.error(`[soak] ${SYNC_TICKS} sync ticks…`);
    // pullOnce wants a Database; we can't easily get one without
    // wiring dofs in. Instead drive fetchChanges directly — same
    // call sites, no DB required, and the leak (if any) shows up
    // here regardless.
    void pullOnce; // referenced for the comment above; unused below
    for (let i = 0; i < SYNC_TICKS; i++) {
      // hasObjects is a pure RPC method that returns a value (no
      // stub envelope). Use it to interleave traffic.
      await client.sync.hasObjects([]);
    }

    // fetchChanges calls — these return stream envelopes.
    console.error(`[soak] ${FETCH_CALLS} fetchChanges calls…`);
    for (let i = 0; i < FETCH_CALLS; i++) {
      const result = await client.sync.fetchChanges({ sinceRev: 0, ignore: [] });
      // Drain the stream so it closes cleanly server-side.
      const reader = result.stream.getReader();
      try {
        // biome-ignore lint/correctness/noConstantCondition: drain loop
        while (true) {
          const { done } = await reader.read();
          if (done) break;
        }
      } finally {
        reader.releaseLock();
      }
      // Intentionally NOT disposing `result` — this is the call
      // site we want to observe.
    }

    // exec calls — each returns { id, events: ReadableStream }, the
    // stream half is where Workers RPC handle stubs would normally
    // accumulate.
    console.error(`[soak] ${EXEC_CALLS} exec calls…`);
    for (let i = 0; i < EXEC_CALLS; i++) {
      const { events } = await client.shell.exec({
        command: "true",
      });
      const reader = events.getReader();
      try {
        // biome-ignore lint/correctness/noConstantCondition: drain loop
        while (true) {
          const { done } = await reader.read();
          if (done) break;
        }
      } finally {
        reader.releaseLock();
      }
    }

    const afterWorkload = await snapshot(port);
    console.error("[soak] after-workload:", JSON.stringify(afterWorkload));

    // Quiet window: let any deferred dispose ticks land.
    await sleep(QUIET_MS);
    const afterQuiet = await snapshot(port);
    console.error("[soak] after-quiet:", JSON.stringify(afterQuiet));

    // Close the session — disposing the root stub should fire
    // dispose on the three root targets too.
    await client.close();
    await sleep(QUIET_MS);
    const afterClose = await snapshot(port);
    console.error("[soak] after-close:", JSON.stringify(afterClose));

    // ─── Verdict ────────────────────────────────────────────────
    const growth = diff(afterConnect, afterQuiet);
    const leakedAfterClose = afterClose;

    const summary = {
      config: { SYNC_TICKS, EXEC_CALLS, FETCH_CALLS, QUIET_MS },
      baseline,
      afterConnect,
      afterWorkload,
      afterQuiet,
      afterClose,
      growthDuringWorkload: growth,
      liveAfterClose: leakedAfterClose,
    };

    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);

    // Human-readable verdict.
    const leaks = Object.entries(growth).filter(([, v]) => v !== 0);
    const stillLiveAfterClose = Object.entries(leakedAfterClose).filter(
      ([, v]) => v !== 0,
    );

    console.error("\n[soak] verdict:");
    if (leaks.length === 0) {
      console.error("  ✓ no growth during workload");
    } else {
      console.error("  ✗ growth during workload:");
      for (const [k, v] of leaks) {
        console.error(`      ${k}: +${v}`);
      }
    }
    if (stillLiveAfterClose.length === 0) {
      console.error("  ✓ all stubs disposed after client.close()");
    } else {
      console.error("  ✗ live stubs after client.close():");
      for (const [k, v] of stillLiveAfterClose) {
        console.error(`      ${k}: ${v}`);
      }
    }
  } finally {
    await cleanup();
    if (process.env.SOAK_DUMP_WSD_STDERR === "1") {
      process.stderr.write(`\n--- wsd stderr ---\n${stderrBuf}`);
    }
  }
}

main().catch((err) => {
  console.error("[soak] failed:", err);
  process.exit(1);
});
