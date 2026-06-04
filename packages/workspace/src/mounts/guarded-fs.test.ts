import { SQLiteTestStorage } from "@cloudflare/dofs/testing";
import { describe, expect, it } from "vitest";

import { Workspace } from "../workspace.js";
import type { EagerMount } from "./types.js";

function makeStorage(): SQLiteTestStorage {
  return new SQLiteTestStorage();
}

const backends = [
  {
    id: "test",
    connect: () => Promise.reject(new Error("not used in these tests")),
  },
];

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

// A no-op eager mount that just records the call. Used so the
// guard layer is exercised without depending on the indexer doing
// real work. The actual indexed status of the mount doesn't
// matter for the guard — GuardedWorkspaceFilesystem checks the
// registered mount mode, not whether materialize() ran.
function noopMount(opts: { mode: "read-only" | "read-write"; kind?: string }): EagerMount {
  return {
    kind: opts.kind ?? "noop",
    mode: opts.mode,
    strategy: "eager",
    async materialize() {},
  };
}

describe("GuardedWorkspaceFilesystem", () => {
  it("rm() under a read-only mount root rejects with EROFS", async () => {
    const ws = new Workspace({
      storage: makeStorage(),
      backends,
      mounts: { "/workspace/r2": noopMount({ mode: "read-only" }) },
    });
    await ws.ensureMountsIndexed();
    await expect(ws.fs.rm("/workspace/r2/some.txt", { force: true })).rejects.toMatchObject({
      code: "EROFS",
    });
  });

  it("mkdir() under a read-only mount root rejects with EROFS", async () => {
    const ws = new Workspace({
      storage: makeStorage(),
      backends,
      mounts: { "/workspace/r2": noopMount({ mode: "read-only" }) },
    });
    await ws.ensureMountsIndexed();
    await expect(ws.fs.mkdir("/workspace/r2/sub", { recursive: true })).rejects.toMatchObject({
      code: "EROFS",
    });
  });

  it("writeFile() at the mount root itself rejects with EROFS", async () => {
    const ws = new Workspace({
      storage: makeStorage(),
      backends,
      mounts: { "/workspace/r2": noopMount({ mode: "read-only" }) },
    });
    await ws.ensureMountsIndexed();
    await expect(ws.fs.writeFile("/workspace/r2", utf8("nope"))).rejects.toMatchObject({
      code: "EROFS",
    });
  });

  it("rm('/workspace') with recursive+force is rejected when a mount exists under /workspace/r2", async () => {
    // Ancestor-rm: the guard must reject because a recursive rm at
    // /workspace would otherwise wipe the materialised /workspace/r2
    // subtree and leave _vfs_mounts.indexed=1 stuck pointing at a
    // ghost.
    const ws = new Workspace({
      storage: makeStorage(),
      backends,
      mounts: { "/workspace/r2": noopMount({ mode: "read-only" }) },
    });
    await ws.ensureMountsIndexed();
    await expect(ws.fs.rm("/workspace", { recursive: true, force: true })).rejects.toMatchObject({
      code: "EROFS",
    });
  });

  it("rm() / mkdir() / writeFile() outside any mount root pass through", async () => {
    const ws = new Workspace({
      storage: makeStorage(),
      backends,
      mounts: { "/workspace/r2": noopMount({ mode: "read-only" }) },
    });
    await ws.ensureMountsIndexed();
    // Writes under a sibling path are unaffected.
    await ws.fs.mkdir("/workspace/free", { recursive: true });
    await ws.fs.writeFile("/workspace/free/a.txt", utf8("ok"));
    expect(await ws.fs.readFile("/workspace/free/a.txt", "utf8")).toBe("ok");
    await ws.fs.rm("/workspace/free/a.txt");
    await expect(ws.fs.readFile("/workspace/free/a.txt", "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("reads of mounted paths pass through unchanged", async () => {
    // The mount writes a file at /workspace/data/hello.txt during
    // materialize(); the guarded fs must read that back without
    // EROFS getting in the way.
    const mount: EagerMount = {
      kind: "seed",
      mode: "read-only",
      strategy: "eager",
      async materialize(api) {
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(utf8("hello"));
            c.close();
          },
        });
        await api.writeFile("/workspace/data/hello.txt", stream);
      },
    };
    const ws = new Workspace({
      storage: makeStorage(),
      backends,
      mounts: { "/workspace/data": mount },
    });
    await ws.ensureMountsIndexed();
    expect(await ws.fs.readFile("/workspace/data/hello.txt", "utf8")).toBe("hello");
  });

  it("writes under a read-write mount pass through to the underlying fs", async () => {
    const ws = new Workspace({
      storage: makeStorage(),
      backends,
      mounts: { "/workspace/scratch": noopMount({ mode: "read-write" }) },
    });
    await ws.ensureMountsIndexed();
    await ws.fs.mkdir("/workspace/scratch", { recursive: true });
    await ws.fs.writeFile("/workspace/scratch/note.txt", utf8("scribble"));
    expect(await ws.fs.readFile("/workspace/scratch/note.txt", "utf8")).toBe("scribble");
    await ws.fs.rm("/workspace/scratch/note.txt");
    await expect(ws.fs.readFile("/workspace/scratch/note.txt", "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
