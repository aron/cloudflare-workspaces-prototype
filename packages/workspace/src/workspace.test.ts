import { SQLiteTestStorage } from "@cloudflare/workspace-fs/testing";
import { describe, expect, it, vi } from "vitest";

import type { BackendHandle, WorkspaceBackend } from "./backend.js";
import { Workspace } from "./workspace.js";

function makeStorage(): SQLiteTestStorage {
  return new SQLiteTestStorage();
}

// In-process fakes. We never spawn anything from the package
// code; the backend's only contract is "produce a SyncRPC
// stub that wsd would speak". A plain object is enough.
function composite(
  sync: import("@cloudflare/workspace-rpc").SyncRPC,
): import("@cloudflare/workspace-rpc").WorkspaceRPC {
  const notWired = () => Promise.reject(new Error("shell not wired in this test"));
  const shell: import("@cloudflare/workspace-rpc").ShellRPC = {
    exec: notWired,
    getExec: notWired,
    killExec: notWired,
    disposeExec: notWired,
  };
  return { sync, shell };
}

function fakeRpc(): import("@cloudflare/workspace-rpc").SyncRPC {
  const blobs = new Map<string, Uint8Array>();
  const files = new Map<
    string,
    { mode: number; mtime: number; size: number; chunks: { hash: Uint8Array; size: number }[] }
  >();

  function hex(bytes: Uint8Array): string {
    let s = "";
    for (let i = 0; i < bytes.byteLength; i++) s += bytes[i].toString(16).padStart(2, "0");
    return s;
  }

  return {
    async push(input) {
      const reader = input.changes.getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value.kind === "file") {
            files.set(value.path, {
              mode: value.mode,
              mtime: value.mtime,
              size: value.size,
              chunks: value.chunks,
            });
          } else if (value.kind === "delete") {
            files.delete(value.path);
          }
        }
      } finally {
        reader.releaseLock();
      }
      return { rev: 0, appliedPushRev: input.senderRev };
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
    async readEntry(path) {
      const entry = files.get(path);
      if (entry === undefined) return null;
      return {
        kind: "file",
        path,
        mode: entry.mode,
        mtime: entry.mtime,
        size: entry.size,
        chunks: entry.chunks,
      };
    },
    async hasObjects(hashes) {
      return hashes.filter((h) => blobs.has(hex(h)));
    },
    fetchObjects(hashes) {
      return new ReadableStream({
        start(c) {
          for (const h of hashes) {
            const bytes = blobs.get(hex(h));
            if (bytes !== undefined) c.enqueue({ hash: h, bytes });
          }
          c.close();
        },
      });
    },
    async watermarks() {
      return { currentRev: 0, pushRev: 0, fetchRev: 0 };
    },
    async pushObjects(objects) {
      const reader = objects.getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          blobs.set(hex(value.hash), value.bytes);
        }
      } finally {
        reader.releaseLock();
      }
    },
  };
}

function makeBackend(
  id: string,
  rpc?: import("@cloudflare/workspace-rpc").SyncRPC,
): WorkspaceBackend {
  return {
    id,
    async connect(): Promise<BackendHandle> {
      return { rpc: composite(rpc ?? fakeRpc()), close: async () => {} };
    },
  };
}

function failingBackend(id: string, reason: string): WorkspaceBackend {
  return {
    id,
    connect: () => Promise.reject(new Error(reason)),
  };
}

describe("Workspace backend fallback", () => {
  it("uses the first backend that connects", async () => {
    const second = makeBackend("second");
    const ws = new Workspace({
      storage: makeStorage(),
      backends: [failingBackend("first", "no thanks"), second],
    });
    await ws.ready();
    expect(ws.fs).toBeDefined();
  });

  it("throws when every backend fails, surfacing each cause", async () => {
    const ws = new Workspace({
      storage: makeStorage(),
      backends: [failingBackend("a", "boom"), failingBackend("b", "kaboom")],
    });
    await expect(ws.ready()).rejects.toThrow(/boom[\s\S]*kaboom/);
  });

  it("ready() is idempotent — subsequent calls reuse the same connection", async () => {
    const backend = makeBackend("only");
    const spy = vi.spyOn(backend, "connect");
    const ws = new Workspace({ storage: makeStorage(), backends: [backend] });
    await ws.ready();
    await ws.ready();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("close() releases the backend handle", async () => {
    let closed = 0;
    const backend: WorkspaceBackend = {
      id: "only",
      async connect() {
        return {
          rpc: composite(fakeRpc()),
          close: async () => {
            closed++;
          },
        };
      },
    };
    const ws = new Workspace({ storage: makeStorage(), backends: [backend] });
    await ws.ready();
    await ws.close();
    expect(closed).toBe(1);
  });

  it("fs accessor throws before ready()", () => {
    const ws = new Workspace({ storage: makeStorage(), backends: [makeBackend("only")] });
    expect(() => ws.fs).toThrow(/not connected/);
  });

  it("requires at least one backend", () => {
    expect(() => new Workspace({ storage: makeStorage(), backends: [] })).toThrow(
      /at least one backend/,
    );
  });
});

describe("WorkspaceFs against a fake SyncRPC", () => {
  it("writeFile then readFile round-trips bytes", async () => {
    const ws = new Workspace({ storage: makeStorage(), backends: [makeBackend("fake")] });
    await ws.ready();
    await ws.fs.writeFile("/a.txt", "hello workspace");
    expect(await ws.fs.readFile("/a.txt", "utf8")).toBe("hello workspace");
  });

  it("writeFile chunks bytes and pushObjects ships them", async () => {
    const ws = new Workspace({ storage: makeStorage(), backends: [makeBackend("fake")] });
    await ws.ready();
    // Two-chunk payload: 600 KiB > 512 KiB chunk size.
    const bytes = new Uint8Array(600 * 1024);
    for (let i = 0; i < bytes.byteLength; i++) bytes[i] = i & 0xff;
    await ws.fs.writeFile("/big.bin", bytes);
    const back = new Uint8Array(await new Response(await ws.fs.readFile("/big.bin")).arrayBuffer());
    expect(back.byteLength).toBe(bytes.byteLength);
    // Spot-check a few bytes; full equality elsewhere would
    // dominate the test runtime.
    expect(back[0]).toBe(bytes[0]);
    expect(back[bytes.byteLength - 1]).toBe(bytes[bytes.byteLength - 1]);
    expect(back[300_000]).toBe(bytes[300_000]);
  });

  it("readFile throws ENOENT for an absent path", async () => {
    const ws = new Workspace({ storage: makeStorage(), backends: [makeBackend("fake")] });
    await ws.ready();
    await expect(ws.fs.readFile("/missing.txt")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("stat returns the ChangeEntry shape for a file", async () => {
    const ws = new Workspace({ storage: makeStorage(), backends: [makeBackend("fake")] });
    await ws.ready();
    await ws.fs.writeFile("/a.txt", "hi");
    const entry = await ws.fs.stat("/a.txt");
    expect(entry).toMatchObject({ kind: "file", path: "/a.txt", size: 2 });
  });

  it("stat returns null for an absent path", async () => {
    const ws = new Workspace({ storage: makeStorage(), backends: [makeBackend("fake")] });
    await ws.ready();
    expect(await ws.fs.stat("/missing")).toBeNull();
  });

  it("writeFile with empty content produces a zero-chunk entry", async () => {
    const ws = new Workspace({ storage: makeStorage(), backends: [makeBackend("fake")] });
    await ws.ready();
    await ws.fs.writeFile("/empty.txt", "");
    const bytes = new Uint8Array(
      await new Response(await ws.fs.readFile("/empty.txt")).arrayBuffer(),
    );
    expect(bytes.byteLength).toBe(0);
  });
});
