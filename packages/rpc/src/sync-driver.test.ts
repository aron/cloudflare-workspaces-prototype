import {
  currentRev,
  Database,
  initializeSchema,
  readWatermark,
  SQLiteWorkspaceProvider,
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
