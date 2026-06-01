// Direct tests for the WorkspaceStub class.
//
// The stub wraps a host-side Workspace as a capnweb RpcTarget so it
// can be returned across a Workers-RPC boundary. The class exposes
// fs and shell sub-stubs via accessor properties (a constraint of
// Workers RPC — plain readonly fields land as private isolate state
// and would report "method not implemented").
//
// These tests construct the stub directly against an in-process
// Workspace; we don't go through workerd. The point is to pin the
// class's own contract: accessor shape, eager spawn, readFile
// overload routing, stat ENOENT propagation, close() idempotency.

import { SQLiteTestStorage } from "@cloudflare/dofs/testing";
import { describe, expect, it } from "vitest";

import type { BackendHandle, WorkspaceBackend } from "./backend.js";
import { WorkspaceExecHandleStub, WorkspaceFilesystemStub, WorkspaceShellStub } from "./stub.js";
import { Workspace } from "./workspace.js";

function composite(
  sync: import("@cloudflare/workspace-rpc").SyncRPC,
  shell?: Partial<import("@cloudflare/workspace-rpc").ShellRPC>,
): import("@cloudflare/workspace-rpc").WorkspaceRPC {
  const notWired = () => Promise.reject(new Error("not wired in this test"));
  return {
    sync,
    shell: {
      exec: notWired,
      getExec: notWired,
      killExec: notWired,
      disposeExec: notWired,
      ...shell,
    },
  };
}

function fakeSync(): import("@cloudflare/workspace-rpc").SyncRPC {
  return {
    async push() {
      return { rev: 0, appliedPushRev: 0 };
    },
    fetchChanges() {
      return new ReadableStream({
        start(c) {
          c.close();
        },
      });
    },
    async currentRev() {
      return 0;
    },
    async readEntry() {
      return null;
    },
    async watermarks() {
      return { currentRev: 0, pushRev: 0, fetchRev: 0 };
    },
    async hasObjects() {
      return [];
    },
    fetchObjects() {
      return new ReadableStream({
        start(c) {
          c.close();
        },
      });
    },
    pushObjects() {
      return Promise.resolve();
    },
  };
}

function backend(
  rpc?: Partial<import("@cloudflare/workspace-rpc").WorkspaceRPC>,
): WorkspaceBackend {
  return {
    id: "test",
    async connect(): Promise<BackendHandle> {
      const sync = rpc?.sync ?? fakeSync();
      const shell = rpc?.shell as Partial<import("@cloudflare/workspace-rpc").ShellRPC> | undefined;
      return { rpc: composite(sync, shell), close: async () => {} };
    },
  };
}

async function withStub<T>(
  fn: (ws: Workspace) => T | Promise<T>,
  options?: { backend?: WorkspaceBackend },
): Promise<T> {
  const ws = new Workspace({
    storage: new SQLiteTestStorage(),
    backends: [options?.backend ?? backend()],
  });
  try {
    await ws.ready();
    return await fn(ws);
  } finally {
    await ws.close();
  }
}

describe("WorkspaceStub", () => {
  it("exposes fs and shell as accessor properties (RPC visibility)", async () => {
    // Plain readonly fields would land as private isolate state on
    // the RPC stub and report "method not implemented". The class
    // uses getters; pin that here by checking the descriptor.
    await withStub(async (ws) => {
      const stub = ws.stub();
      const fsDesc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(stub), "fs");
      const shellDesc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(stub), "shell");
      expect(fsDesc?.get).toBeTypeOf("function");
      expect(shellDesc?.get).toBeTypeOf("function");
      expect(stub.fs).toBeInstanceOf(WorkspaceFilesystemStub);
      expect(stub.shell).toBeInstanceOf(WorkspaceShellStub);
    });
  });

  it("fs.writeFile + fs.readFile round-trip utf8", async () => {
    await withStub(async (ws) => {
      const stub = ws.stub();
      await stub.fs.writeFile("/hello.txt", "hello stub");
      expect(await stub.fs.readFile("/hello.txt", "utf8")).toBe("hello stub");
    });
  });

  it("fs.readFile returns a ReadableStream by default", async () => {
    await withStub(async (ws) => {
      const stub = ws.stub();
      await stub.fs.writeFile("/bin", new Uint8Array([7, 8, 9]));
      const stream = await stub.fs.readFile("/bin");
      expect(stream).toBeInstanceOf(ReadableStream);
      const buf = new Uint8Array(await new Response(stream).arrayBuffer());
      expect(Array.from(buf)).toEqual([7, 8, 9]);
    });
  });

  it("fs.stat propagates ENOENT for missing paths", async () => {
    await withStub(async (ws) => {
      const stub = ws.stub();
      await expect(stub.fs.stat("/missing")).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("shell.exec returns an eagerly-spawned handle", async () => {
    // The stub's exec() kicks off the underlying workspace.shell.exec
    // before returning, so the caller's first round trip already has
    // the spawn in flight. We can't directly observe "eager" without
    // a clock, but we can pin that the returned handle is the right
    // shape and that result() resolves.
    let execCalls = 0;
    const shellRpc: import("@cloudflare/workspace-rpc").ShellRPC = {
      async exec() {
        execCalls += 1;
        return {
          id: `e-${execCalls}`,
          events: new ReadableStream({
            start(c) {
              c.enqueue({ id: `e-${execCalls}`, seq: 1, name: "stdout", value: new Uint8Array() });
              c.enqueue({ id: `e-${execCalls}`, seq: 2, name: "exit", value: 0 });
              c.close();
            },
          }),
        };
      },
      getExec: () => Promise.reject(new Error("not used")),
      killExec: () => Promise.reject(new Error("not used")),
      disposeExec: () => Promise.reject(new Error("not used")),
    };
    await withStub(
      async (ws) => {
        const stub = ws.stub();
        const handle = await stub.shell.exec("noop");
        expect(handle).toBeInstanceOf(WorkspaceExecHandleStub);
        // exec ran by the time result() resolves. The stub kicks off
        // the underlying exec eagerly (via promise chaining) so the
        // caller doesn't pay an extra round trip before result().
        const res = await handle.result();
        expect(execCalls).toBe(1);
        expect(res.exitCode).toBe(0);
      },
      { backend: backend({ shell: shellRpc }) },
    );
  });
});
