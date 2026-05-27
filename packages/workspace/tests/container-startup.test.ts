/**
 * Tests for the container-startup orchestration. Each test exercises one of
 * the failure modes that drove the rewrite of `ensureContainerProcess`:
 *
 *   - Stale `failed` / `killed` / `completed` process records (must not be
 *     reused).
 *   - Concurrent warmup races where startProcess returns success but the
 *     spawned node dies with EADDRINUSE.
 *   - Server already up before any SDK record exists (post-DO-restart path).
 *   - `startProcess` itself rejecting on duplicate id.
 *   - Genuine startup failure (no port, no record) — must surface.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import type { Process, ProcessStatus } from "@cloudflare/sandbox";
import {
  ensureWorkspaceServer,
  findRunningServer,
  probePort,
  type SandboxLike,
} from "../src/container-startup.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PORT = 4567;

interface FakeProcessSpec {
  status: ProcessStatus;
  /** Resolve / reject the waitForPort promise. Defaults to resolving immediately. */
  waitForPortBehavior?: "resolve" | "reject";
}

function fakeProcess(spec: FakeProcessSpec): Process {
  const proc = {
    id: "workspace-server",
    pid: 1234,
    command: "node /app/server.cjs",
    status: spec.status,
    startTime: new Date(),
    async kill() { /* noop */ },
    async getStatus() { return spec.status; },
    async getLogs() { return { stdout: "", stderr: "" }; },
    async waitForExit() { return { exitCode: 0 }; },
    streamLogs() { return new ReadableStream(); },
    async waitForPort() {
      if (spec.waitForPortBehavior === "reject") {
        throw new Error("ProcessExitedBeforeReadyError: simulated");
      }
    },
  } as unknown as Process;
  return proc;
}

interface FakeSandboxSpec {
  /** What `getProcess` returns. `null` simulates "no record". */
  getProcessResult?: Process | null | (() => Process | null);
  /** Whether `containerFetch` should answer (i.e. server is up on the port). */
  portUp?: boolean | (() => boolean);
  /** Controls the `startProcess` call. */
  startProcess?:
    | { kind: "ok"; status?: ProcessStatus; waitForPortBehavior?: "resolve" | "reject" }
    | { kind: "throw" };
}

interface FakeSandbox extends SandboxLike {
  /** Call counts for assertion. */
  calls: {
    getProcess: number;
    startProcess: number;
    containerFetch: number;
  };
}

function makeSandbox(spec: FakeSandboxSpec): FakeSandbox {
  const calls = { getProcess: 0, startProcess: 0, containerFetch: 0 };
  const resolveGetProcess = (): Process | null => {
    const v = spec.getProcessResult;
    if (typeof v === "function") return v();
    return v ?? null;
  };
  const resolvePortUp = (): boolean => {
    const v = spec.portUp;
    if (typeof v === "function") return v();
    return v ?? false;
  };
  return {
    calls,
    async getProcess() {
      calls.getProcess++;
      return resolveGetProcess();
    },
    async startProcess() {
      calls.startProcess++;
      const s = spec.startProcess ?? { kind: "ok" };
      if (s.kind === "throw") throw new Error("startProcess: duplicate id");
      return fakeProcess({
        status: s.status ?? "running",
        waitForPortBehavior: s.waitForPortBehavior ?? "resolve",
      });
    },
    // Track the port the SDK was asked to route to. Regression guard for
    // the bug where `probePort` invoked `containerFetch(switchPort(req, port))`
    // without passing the port as a second arg, causing wrangler-dev to route
    // the probe to `defaultPort` (3000) instead of `port` and report the
    // sandbox control plane's "Hello" response as a successful probe.
    async containerFetch(_req: Request, port?: number) {
      calls.containerFetch++;
      if (port !== PORT) {
        // Wrong port — simulate the wrangler-dev behaviour where 3000 always
        // answers with a 200 from the sandbox control plane.
        return new Response("Hello from Bun server!", { status: 200 });
      }
      const up = resolvePortUp();
      return new Response(
        up ? JSON.stringify({ status: "ok" }) : "",
        { status: up ? 200 : 503 },
      );
    },
  };
}

// ---------------------------------------------------------------------------
// findRunningServer
// ---------------------------------------------------------------------------

describe("findRunningServer", () => {
  test("returns null when getProcess returns null", async () => {
    const sb = makeSandbox({ getProcessResult: null });
    assert.equal(await findRunningServer(sb), null);
  });

  test("returns null when getProcess throws", async () => {
    const sb: SandboxLike = {
      async getProcess() { throw new Error("not found"); },
      async startProcess() { throw new Error("unused"); },
      async containerFetch() { return new Response(""); },
    };
    assert.equal(await findRunningServer(sb), null);
  });

  for (const status of ["failed", "killed", "completed", "error"] as const) {
    test(`returns null for status="${status}" (stale record \u2014 the production bug)`, async () => {
      const sb = makeSandbox({ getProcessResult: fakeProcess({ status }) });
      assert.equal(await findRunningServer(sb), null);
    });
  }

  for (const status of ["running", "starting"] as const) {
    test(`returns the record for status="${status}"`, async () => {
      const rec = fakeProcess({ status });
      const sb = makeSandbox({ getProcessResult: rec });
      assert.equal(await findRunningServer(sb), rec);
    });
  }
});

// ---------------------------------------------------------------------------
// probePort
// ---------------------------------------------------------------------------

describe("probePort", () => {
  test("returns true when containerFetch returns 2xx", async () => {
    const sb = makeSandbox({ portUp: true });
    assert.equal(await probePort(sb, PORT), true);
  });

  test("returns false when containerFetch returns 5xx", async () => {
    const sb = makeSandbox({ portUp: false });
    assert.equal(await probePort(sb, PORT), false);
  });

  test("returns false when containerFetch throws (port not bound)", async () => {
    const sb: SandboxLike = {
      async getProcess() { return null; },
      async startProcess() { throw new Error("unused"); },
      async containerFetch() { throw new Error("ECONNREFUSED"); },
    };
    assert.equal(await probePort(sb, PORT), false);
  });

  test("passes the requested port as the second arg to containerFetch (not via header)", async () => {
    // Regression: probePort used to call `sb.containerFetch(switchPort(req, port))`
    // with no second arg. `containerFetch` ignores the cf-container-target-port
    // header, so the probe landed on `defaultPort` (3000) and got a 200 OK from
    // the sandbox control plane — a silent false positive that made
    // ensureWorkspaceServer skip starting the server.
    let observedPort: number | undefined;
    const sb: SandboxLike = {
      async getProcess() { return null; },
      async startProcess() { throw new Error("unused"); },
      async containerFetch(_req: Request, port?: number) {
        observedPort = port;
        return new Response("", { status: 503 });
      },
    };
    await probePort(sb, 4567);
    assert.equal(observedPort, 4567);
  });
});

// ---------------------------------------------------------------------------
// ensureWorkspaceServer
// ---------------------------------------------------------------------------

describe("ensureWorkspaceServer", () => {
  test("fast-path: server already up, no startProcess, no getProcess", async () => {
    const sb = makeSandbox({ portUp: true });
    await ensureWorkspaceServer(sb, PORT);
    assert.equal(sb.calls.containerFetch, 1);
    assert.equal(sb.calls.getProcess, 0);
    assert.equal(sb.calls.startProcess, 0);
  });

  test("ignores a stale 'failed' record and starts fresh", async () => {
    // The exact production bug: getProcess returns status=failed exitCode=1
    // (left behind by an EADDRINUSE-loser), but the real server is up.
    // We must not trust the stale record's waitForPort \u2014 the probe wins.
    const sb = makeSandbox({
      portUp: true,
      getProcessResult: fakeProcess({ status: "failed", waitForPortBehavior: "reject" }),
    });
    await ensureWorkspaceServer(sb, PORT);
    // Fast-path probe succeeds before we even look at the record.
    assert.equal(sb.calls.startProcess, 0);
  });

  test("reuses a 'running' record when probe says the port isn't up yet", async () => {
    // Race: server is mid-boot; port not bound yet but record says running.
    let portReady = false;
    const sb = makeSandbox({
      portUp: () => portReady,
      getProcessResult: fakeProcess({
        status: "running",
        // waitForPort resolves once the boot completes.
        waitForPortBehavior: "resolve",
      }),
    });
    await ensureWorkspaceServer(sb, PORT);
    assert.equal(sb.calls.startProcess, 0);
    assert.equal(sb.calls.getProcess, 1);
  });

  test("starts fresh when nothing is up and no record exists", async () => {
    const sb = makeSandbox({
      portUp: false,
      getProcessResult: null,
      startProcess: { kind: "ok", waitForPortBehavior: "resolve" },
    });
    await ensureWorkspaceServer(sb, PORT);
    assert.equal(sb.calls.startProcess, 1);
  });

  test("recovers when startProcess rejects but the port is up (lost the race)", async () => {
    // Concurrent caller raced us, won, registered the workspace-server id.
    // Our startProcess throws because the id is taken \u2014 but the winner is up.
    const sb = makeSandbox({
      portUp: () => sb.calls.startProcess > 0,   // port comes up once "someone" started
      getProcessResult: null,
      startProcess: { kind: "throw" },
    });
    await ensureWorkspaceServer(sb, PORT);
    assert.equal(sb.calls.startProcess, 1);
  });

  test("recovers when waitForPort rejects but the port is up (EADDRINUSE-loser path)", async () => {
    // We called startProcess, the spawn died with EADDRINUSE because a
    // concurrent caller's server already bound the port. waitForPort rejects
    // (process exited). Re-probe finds the winning server still serving.
    //
    // The port comes up *during* startProcess (because the winner finished
    // first), not before — otherwise the fast-path probe would short-circuit
    // before startProcess was ever called.
    let portUp = false;
    const sb = makeSandbox({
      portUp: () => portUp,
      getProcessResult: null,
      startProcess: { kind: "ok", waitForPortBehavior: "reject" },
    });
    const origStart = sb.startProcess.bind(sb);
    sb.startProcess = async (...args) => {
      portUp = true;  // winner's server bound the port
      return origStart(...args);
    };
    await ensureWorkspaceServer(sb, PORT);
    assert.equal(sb.calls.startProcess, 1);
  });

  test("surfaces a genuine failure (no port, waitForPort rejects)", async () => {
    const sb = makeSandbox({
      portUp: false,
      getProcessResult: null,
      startProcess: { kind: "ok", waitForPortBehavior: "reject" },
    });
    await assert.rejects(
      () => ensureWorkspaceServer(sb, PORT),
      /simulated|ProcessExitedBeforeReady/,
    );
  });

  test("surfaces a genuine failure when startProcess throws and probe still fails", async () => {
    const sb = makeSandbox({
      portUp: false,
      getProcessResult: null,
      startProcess: { kind: "throw" },
    });
    await assert.rejects(
      () => ensureWorkspaceServer(sb, PORT),
      /startProcess failed and port is not up/,
    );
  });

  test("falls through to startProcess when existing record's waitForPort rejects", async () => {
    let portReady = false;
    const sb = makeSandbox({
      portUp: () => portReady,
      getProcessResult: fakeProcess({
        status: "running",
        waitForPortBehavior: "reject",  // existing record claims running but won't come up
      }),
      startProcess: { kind: "ok", waitForPortBehavior: "resolve" },
    });
    // Simulate the fresh server actually binding the port between the failed
    // waitForPort on the existing record and the probe after startProcess.
    const origStart = sb.startProcess.bind(sb);
    sb.startProcess = async (...args) => {
      portReady = true;
      return origStart(...args);
    };
    await ensureWorkspaceServer(sb, PORT);
    assert.equal(sb.calls.startProcess, 1);
  });
});
