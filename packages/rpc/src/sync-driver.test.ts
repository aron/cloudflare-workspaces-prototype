import {
  type ChangeEntry,
  currentRev,
  Database,
  initializeSchema,
  readWatermark,
  SQLiteWorkspaceProvider,
  stageBlob,
} from "@cloudflare/dofs";
import { SQLiteTestStorage } from "@cloudflare/dofs/testing";
import { describe, expect, it } from "vitest";

import type { SyncRPC } from "./interface.js";
import { createSyncServer } from "./server.js";
import { pullOnce, pushOnce, tick } from "./sync-driver.js";

// Two peers wired up as direct in-process SyncRPC stubs. No
// WebSocket; we already have the real-wire convergence test in
// wire.test.ts. These tests exercise the driver loop, not the
// transport.
function makePeer(): { db: Database; rpc: SyncRPC; close: () => void } {
  const storage = new SQLiteTestStorage();
  const db = new Database(storage);
  initializeSchema(db, () => 1000);
  const rpc = createSyncServer(db);
  return { db, rpc, close: () => storage.close() };
}

function fileEntries(db: Database): string[] {
  return db
    .all<{ name: string }>("SELECT name FROM vfs_dirents WHERE parent_inode = 1 ORDER BY name")
    .map((r) => r.name);
}

describe("sync driver — pullOnce", () => {
  it("pulls a single entry from upstream", async () => {
    const a = makePeer();
    const b = makePeer();
    try {
      const provider = new SQLiteWorkspaceProvider(a.db, { now: () => 1 });
      provider.writeFileSync("/hello.txt", "hello");

      const applied = await pullOnce(b.db, a.rpc);
      expect(applied).toBe(1);
      expect(fileEntries(b.db)).toContain("hello.txt");
      // Asserting the bytes arrived, not just the dirent. The
      // production wsd-container example had a path where pullOnce
      // returned 1 (entry materialised) but the file's chunks were
      // empty on the receiver — RPC reads landed HTTP 200 / 0 bytes.
      const providerB = new SQLiteWorkspaceProvider(b.db, { now: () => 1 });
      expect(providerB.readFileSync("/hello.txt", "utf8")).toBe("hello");
    } finally {
      a.close();
      b.close();
    }
  });

  it("pulls bytes written through the fd table (FUSE-shaped write)", async () => {
    // Mirrors the FUSE path: openSync + writeSync + closeSync rather
    // than the whole-file writeFileSync above. Both go through
    // writeFileSyncImpl internally and should bump vfs_nodes.rev
    // identically; this test pins that pull semantics survive the
    // positional-write flow that FUSE uses.
    const a = makePeer();
    const b = makePeer();
    try {
      const providerA = new SQLiteWorkspaceProvider(a.db, { now: () => 1 });
      const fd = providerA.openSync("/fuse.txt", "w");
      const payload = Buffer.from("from-fuse\n", "utf8");
      providerA.writeSync(fd, payload, 0, payload.byteLength, null);
      providerA.closeSync(fd);

      const applied = await pullOnce(b.db, a.rpc);
      expect(applied).toBe(1);
      expect(fileEntries(b.db)).toContain("fuse.txt");

      // The production bug: the dirent transferred but readback was
      // empty. Assert byte equality, not just dirent presence.
      const providerB = new SQLiteWorkspaceProvider(b.db, { now: () => 1 });
      expect(providerB.readFileSync("/fuse.txt", "utf8")).toBe("from-fuse\n");
    } finally {
      a.close();
      b.close();
    }
  });

  it("is a no-op when fetchRev equals upstream currentRev", async () => {
    const a = makePeer();
    const b = makePeer();
    try {
      await pullOnce(b.db, a.rpc);
      const applied = await pullOnce(b.db, a.rpc);
      expect(applied).toBe(0);
    } finally {
      a.close();
      b.close();
    }
  });
});

describe("sync driver — pushOnce", () => {
  it("pushes local entries to the remote", async () => {
    const a = makePeer();
    const b = makePeer();
    try {
      const providerA = new SQLiteWorkspaceProvider(a.db, { now: () => 1 });
      providerA.writeFileSync("/hi.txt", "hi");

      const pushed = await pushOnce(a.db, b.rpc);
      expect(pushed).toBe(1);
      expect(fileEntries(b.db)).toContain("hi.txt");
    } finally {
      a.close();
      b.close();
    }
  });

  it("advances pushRev on success", async () => {
    const a = makePeer();
    const b = makePeer();
    try {
      const providerA = new SQLiteWorkspaceProvider(a.db, { now: () => 1 });
      providerA.writeFileSync("/hi.txt", "hi");
      await pushOnce(a.db, b.rpc);
      expect(readWatermark(a.db, "pushRev")).toBe(currentRev(a.db));
    } finally {
      a.close();
      b.close();
    }
  });
});

describe("sync driver — bidirectional convergence", () => {
  it("two peers writing in parallel converge after a few ticks", async () => {
    const a = makePeer();
    const b = makePeer();
    try {
      const providerA = new SQLiteWorkspaceProvider(a.db, { now: () => 1 });
      const providerB = new SQLiteWorkspaceProvider(b.db, { now: () => 2 });

      providerA.writeFileSync("/from-a.txt", "alpha");
      providerB.writeFileSync("/from-b.txt", "beta");

      // Alternate ticks until both sides see both files. Each tick
      // is pull-then-push against the *other* peer's rpc.
      for (let i = 0; i < 4; i++) {
        await tick(a.db, b.rpc);
        await tick(b.db, a.rpc);
      }

      expect(fileEntries(a.db).sort()).toEqual(["from-a.txt", "from-b.txt"]);
      expect(fileEntries(b.db).sort()).toEqual(["from-a.txt", "from-b.txt"]);
    } finally {
      a.close();
      b.close();
    }
  });

  it("an upstream entry does not get re-pushed (loopback suppression)", async () => {
    const a = makePeer();
    const b = makePeer();
    try {
      const providerA = new SQLiteWorkspaceProvider(a.db, { now: () => 1 });
      providerA.writeFileSync("/from-a.txt", "alpha");

      // First tick: B pulls from A.
      await tick(b.db, a.rpc);
      expect(fileEntries(b.db)).toContain("from-a.txt");

      // Second tick: B has nothing new to push back. If the
      // loopback suppression is broken, applyChanges bumped
      // vfs_meta.rev on the apply, and the push side would re-ship
      // the same entry.
      const result = await tick(b.db, a.rpc);
      expect(result.pushed).toBe(0);
    } finally {
      a.close();
      b.close();
    }
  });

  it("a settled pair stays settled across additional ticks", async () => {
    const a = makePeer();
    const b = makePeer();
    try {
      const providerA = new SQLiteWorkspaceProvider(a.db, { now: () => 1 });
      providerA.writeFileSync("/x.txt", "x");
      for (let i = 0; i < 3; i++) {
        await tick(a.db, b.rpc);
        await tick(b.db, a.rpc);
      }
      const result1 = await tick(a.db, b.rpc);
      const result2 = await tick(b.db, a.rpc);
      expect(result1).toEqual({ pulled: 0, pushed: 0 });
      expect(result2).toEqual({ pulled: 0, pushed: 0 });
    } finally {
      a.close();
      b.close();
    }
  });
});

describe("sync driver — cross-side invariant", () => {
  it("pushOnce throws when the remote echoes back a lower appliedPushRev", async () => {
    const a = makePeer();
    const b = makePeer();
    try {
      const providerA = new SQLiteWorkspaceProvider(a.db, { now: () => 1 });
      providerA.writeFileSync("/x.txt", "x");

      // Wrap B's rpc to lie about appliedPushRev. Simulates a
      // regression in the suppress-dirty-tracking apply path.
      const lyingRpc = new Proxy(b.rpc as object, {
        get(target, prop, receiver) {
          if (prop === "push") {
            return async (input: { senderRev: number; changes: ReadableStream<unknown> }) => {
              const real = await Reflect.get(target, prop, receiver).call(target, input);
              return { ...real, appliedPushRev: 0 };
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      }) as typeof b.rpc;

      await expect(pushOnce(a.db, lyingRpc)).rejects.toThrow(/cross-side invariant violated/i);
    } finally {
      a.close();
      b.close();
    }
  });
});

describe("sync driver — streaming pullOnce", () => {
  it("applies the entry stream in batches rather than buffering it whole", async () => {
    // Source writes more entries than the batch size. The receiver
    // should call hasObjects() more than once — once per batch —
    // proving it didn't buffer the entire entry stream first.
    const a = makePeer();
    const b = makePeer();
    try {
      const providerA = new SQLiteWorkspaceProvider(a.db, { now: () => 1 });
      // PULL_BATCH_SIZE in sync-driver.ts is 256. Write twice that to
      // force at least two batches.
      const total = 600;
      for (let i = 0; i < total; i++) {
        providerA.writeFileSync(`/f${i}.txt`, `c${i}`);
      }
      let hasObjectsCalls = 0;
      const wrapped = new Proxy(a.rpc as object, {
        get(target, prop, receiver) {
          if (prop === "hasObjects") {
            return async (hashes: Uint8Array[]) => {
              hasObjectsCalls++;
              return Reflect.get(target, prop, receiver).call(target, hashes);
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      }) as typeof a.rpc;
      const applied = await pullOnce(b.db, wrapped);
      expect(applied).toBe(total);
      expect(fileEntries(b.db).length).toBe(total);
      // With a 256-entry batch we expect at least 3 calls.
      expect(hasObjectsCalls).toBeGreaterThanOrEqual(3);
    } finally {
      a.close();
      b.close();
    }
  });
});

describe("sync driver — push atomicity", () => {
  it("rolls back the entire batch when applyChanges fails mid-stream", async () => {
    // Construct a push with two file entries: one whose chunk bytes
    // are staged, and one whose chunk hash is bogus so applyChanges
    // throws while assembling the second file. Without atomicity the
    // first file would land in vfs_nodes; with the push wrapped in a
    // transactionSync, both should roll back.
    const b = makePeer();
    try {
      const goodBytes = new TextEncoder().encode("good");
      const goodHash = await sha256(goodBytes);
      stageBlob(b.db, goodHash, goodBytes, 1);
      const bogusHash = new Uint8Array(32);
      bogusHash.fill(0xee);
      const entries: ChangeEntry[] = [
        {
          kind: "file",
          path: "/first.txt",
          mode: 0o644,
          mtime: 1,
          size: goodBytes.byteLength,
          chunks: [{ hash: goodHash, size: goodBytes.byteLength }],
        },
        {
          kind: "file",
          path: "/second.txt",
          mode: 0o644,
          mtime: 1,
          size: 4,
          chunks: [{ hash: bogusHash, size: 4 }],
        },
      ];
      const changes = new ReadableStream<ChangeEntry>({
        start(controller) {
          for (const e of entries) controller.enqueue(e);
          controller.close();
        },
      });
      const beforeRev = currentRev(b.db);
      // External orchestrator: senderRev = 0.
      await expect(b.rpc.push({ senderRev: 0, changes })).rejects.toThrow(/missing object/i);
      // Neither file should be present — the failure rolled back
      // everything, not just the bad entry.
      expect(fileEntries(b.db)).not.toContain("first.txt");
      expect(fileEntries(b.db)).not.toContain("second.txt");
      // currentRev must not have advanced. Without atomicity it
      // would have, because /first.txt's writeFile bumped vfs_meta.rev
      // before /second.txt's failure.
      expect(currentRev(b.db)).toBe(beforeRev);
    } finally {
      b.close();
    }
  });
});

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256");
  hash.update(bytes);
  return new Uint8Array(hash.digest());
}
