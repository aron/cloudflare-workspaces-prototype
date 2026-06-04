import { SQLiteTestStorage } from "@cloudflare/dofs/testing";
import { describe, expect, it } from "vitest";

import { Workspace } from "../workspace.js";
import type { EagerMount, MountWriteAPI } from "./types.js";

function makeStorage(): SQLiteTestStorage {
  return new SQLiteTestStorage();
}

const backends = [
  {
    id: "test",
    connect: () => Promise.reject(new Error("not used in these tests")),
  },
];

// Build a ReadableStream<Uint8Array> from a single byte payload.
function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

interface FakeFile {
  path: string;
  bytes: Uint8Array;
  mode?: number;
}

function fakeMount(opts: {
  files: FakeFile[];
  dirs?: Array<{ path: string; mode?: number }>;
  kind?: string;
  onMaterialize?: () => void;
  throwAfter?: number; // throw after writing N files
}): EagerMount & { calls: number } {
  return {
    kind: opts.kind ?? "fake",
    mode: "read-only",
    strategy: "eager",
    calls: 0,
    async materialize(api: MountWriteAPI) {
      // biome-ignore lint/suspicious/noExplicitAny: self-reference for the call counter
      (this as any).calls += 1;
      opts.onMaterialize?.();
      for (const d of opts.dirs ?? []) {
        await api.mkdir(d.path, d.mode);
      }
      let i = 0;
      for (const f of opts.files) {
        if (opts.throwAfter !== undefined && i >= opts.throwAfter) {
          throw new Error("boom mid-materialize");
        }
        await api.writeFile(f.path, streamOf(f.bytes), f.mode);
        i++;
      }
    },
  };
}

async function readAll(ws: Workspace, path: string): Promise<Uint8Array> {
  const stream = await ws.fs.readFile(path);
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) parts.push(value);
  }
  reader.releaseLock();
  let len = 0;
  for (const p of parts) len += p.byteLength;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

describe("mount indexer", () => {
  it("materializes files into vfs_nodes and reads bypass the mount", async () => {
    const mount = fakeMount({
      files: [
        { path: "/workspace/data/a.txt", bytes: utf8("alpha") },
        { path: "/workspace/data/sub/b.txt", bytes: utf8("beta") },
        { path: "/workspace/data/sub/c.txt", bytes: utf8("gamma") },
      ],
    });
    const ws = new Workspace({
      storage: makeStorage(),
      backends,
      mounts: { "/workspace/data": mount },
    });
    await ws.ensureMountsIndexed();
    expect(mount.calls).toBe(1);

    expect(new TextDecoder().decode(await readAll(ws, "/workspace/data/a.txt"))).toBe("alpha");
    expect(new TextDecoder().decode(await readAll(ws, "/workspace/data/sub/b.txt"))).toBe("beta");
    expect(new TextDecoder().decode(await readAll(ws, "/workspace/data/sub/c.txt"))).toBe("gamma");

    // Reads must not re-invoke the mount.
    expect(mount.calls).toBe(1);
  });

  it("records one row per mount in _vfs_mounts with indexed=1", async () => {
    const m1 = fakeMount({
      kind: "kind-1",
      files: [{ path: "/workspace/a/f.txt", bytes: utf8("x") }],
    });
    const m2 = fakeMount({
      kind: "kind-2",
      files: [{ path: "/workspace/b/g.txt", bytes: utf8("y") }],
    });
    const ws = new Workspace({
      storage: makeStorage(),
      backends,
      mounts: { "/workspace/a": m1, "/workspace/b": m2 },
    });
    await ws.ensureMountsIndexed();
    const rows = ws.db
      .all<{ root: string; kind: string; indexed: number }>(
        "SELECT root, kind, indexed FROM _vfs_mounts ORDER BY root",
      )
      .map((r) => ({ ...r }));
    expect(rows).toEqual([
      { root: "/workspace/a", kind: "kind-1", indexed: 1 },
      { root: "/workspace/b", kind: "kind-2", indexed: 1 },
    ]);
  });

  it("does not re-materialize on a second workspace over the same store", async () => {
    const storage = makeStorage();
    const mount1 = fakeMount({ files: [{ path: "/workspace/m/x.txt", bytes: utf8("hi") }] });
    const ws1 = new Workspace({
      storage,
      backends,
      mounts: { "/workspace/m": mount1 },
    });
    await ws1.ensureMountsIndexed();
    expect(mount1.calls).toBe(1);

    const mount2 = fakeMount({ files: [{ path: "/workspace/m/x.txt", bytes: utf8("hi") }] });
    const ws2 = new Workspace({
      storage,
      backends,
      mounts: { "/workspace/m": mount2 },
    });
    await ws2.ensureMountsIndexed();
    expect(mount2.calls).toBe(0);
    expect(new TextDecoder().decode(await readAll(ws2, "/workspace/m/x.txt"))).toBe("hi");
  });

  it("streams a 1 MiB writeFile in 4 KiB chunks into multiple stored chunks", async () => {
    const total = 1 << 20; // 1 MiB
    const pieceSize = 4 * 1024; // 4 KiB
    const big = new Uint8Array(total);
    for (let i = 0; i < total; i++) big[i] = i & 0xff;
    const source = (): ReadableStream<Uint8Array> =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (let off = 0; off < total; off += pieceSize) {
            controller.enqueue(big.subarray(off, Math.min(off + pieceSize, total)));
          }
          controller.close();
        },
      });
    const mount: EagerMount = {
      kind: "big",
      mode: "read-only",
      strategy: "eager",
      async materialize(api) {
        await api.writeFile("/workspace/big/blob.bin", source());
      },
    };
    const ws = new Workspace({
      storage: makeStorage(),
      backends,
      mounts: { "/workspace/big": mount },
    });
    await ws.ensureMountsIndexed();
    const bytes = await readAll(ws, "/workspace/big/blob.bin");
    expect(bytes.byteLength).toBe(total);
    // The dofs CHUNK_SIZE is 512 KiB; a 1 MiB blob should land
    // exactly two chunks.
    const inodeRow = ws.db.one<{ inode: number }>(
      "SELECT n.inode AS inode FROM vfs_nodes n JOIN vfs_dirents d1 ON d1.child_inode=n.inode WHERE d1.name='blob.bin'",
    );
    const chunks = ws.db.all<{ size: number }>(
      "SELECT size FROM vfs_chunks WHERE inode = ? ORDER BY idx",
      // biome-ignore lint/style/noNonNullAssertion: query must succeed in this test
      inodeRow!.inode,
    );
    const sum = chunks.reduce((s, c) => s + c.size, 0);
    expect(sum).toBe(total);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const c of chunks) {
      expect(c.size).toBeLessThanOrEqual(512 * 1024);
    }
  });

  it("leaves indexed=0 and an empty subtree when materialize() throws", async () => {
    const storage = makeStorage();
    const mount = fakeMount({
      files: [
        { path: "/workspace/m/a.txt", bytes: utf8("a") },
        { path: "/workspace/m/b.txt", bytes: utf8("b") },
      ],
      throwAfter: 1,
    });
    const ws = new Workspace({
      storage,
      backends,
      mounts: { "/workspace/m": mount },
    });
    await expect(ws.ensureMountsIndexed()).rejects.toThrow(/boom/);

    const persisted = ws.db.one<{ indexed: number }>(
      "SELECT indexed FROM _vfs_mounts WHERE root = ?",
      "/workspace/m",
    );
    expect(persisted?.indexed ?? 0).toBe(0);
    // No leftover dirents under the mount root.
    const leftover = ws.db.all<{ name: string }>(
      "SELECT d.name FROM vfs_dirents d JOIN vfs_nodes n ON n.inode = d.parent_inode",
    );
    const hasMountChildren = leftover.some((r) => r.name === "a.txt" || r.name === "b.txt");
    expect(hasMountChildren).toBe(false);

    // Second attempt: replace the mount with a clean one and run
    // again. The next pass should call materialize() again because
    // the previous run is still indexed=0.
    const recover = fakeMount({
      files: [{ path: "/workspace/m/a.txt", bytes: utf8("ok") }],
    });
    const ws2 = new Workspace({
      storage,
      backends,
      mounts: { "/workspace/m": recover },
    });
    await ws2.ensureMountsIndexed();
    expect(recover.calls).toBe(1);
    expect(new TextDecoder().decode(await readAll(ws2, "/workspace/m/a.txt"))).toBe("ok");
  });

  it("throws when materialize exceeds maxBytes and leaves vfs_nodes empty", async () => {
    const mount: EagerMount = {
      kind: "huge",
      mode: "read-only",
      strategy: "eager",
      maxBytes: 100,
      async materialize(api) {
        await api.writeFile("/workspace/cap/big.bin", streamOf(new Uint8Array(1024)));
      },
    };
    const ws = new Workspace({
      storage: makeStorage(),
      backends,
      mounts: { "/workspace/cap": mount },
    });
    await expect(ws.ensureMountsIndexed()).rejects.toThrow(/maxBytes|byte/i);
    const inode = ws.db.one("SELECT inode FROM vfs_nodes WHERE manifest_hash IS NOT NULL");
    expect(inode).toBeUndefined();
  });

  it("collapses concurrent ensureMountsIndexed() calls to one materialize", async () => {
    let entered = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const mount: EagerMount = {
      kind: "slow",
      mode: "read-only",
      strategy: "eager",
      async materialize(api) {
        entered += 1;
        await gate;
        await api.writeFile("/workspace/s/f.txt", streamOf(utf8("ok")));
      },
    };
    const ws = new Workspace({
      storage: makeStorage(),
      backends,
      mounts: { "/workspace/s": mount },
    });
    const a = ws.ensureMountsIndexed();
    const b = ws.ensureMountsIndexed();
    // biome-ignore lint/style/noNonNullAssertion: release is set inside the gate promise
    release!();
    await Promise.all([a, b]);
    expect(entered).toBe(1);
  });
});
