import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import {
  type ChangeEntry,
  coalesceChanges,
  Database,
  fetchObjects,
  initializeSchema,
  ROOT_INODE,
  SQLiteTestStorage,
  SQLiteWorkspaceProvider,
} from "@cloudflare/workspace-fs";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";

import { createSyncClient } from "./client.js";
import { acceptWebSocketSession, createSyncServer } from "./server.js";

interface Harness {
  url: string;
  db: Database;
  close: () => Promise<void>;
}

// Stand up a real HTTP + WebSocket server bound to 127.0.0.1, with a
// fresh in-memory SQLite-backed VFS behind a SyncRPC adapter. Returns
// the ws:// URL the client should dial. Each test calls
// teardown via `await harness.close()` in afterEach.
async function startHarness(): Promise<Harness> {
  const storage = new SQLiteTestStorage();
  const db = new Database(storage);
  initializeSchema(db, () => 1000);
  const rpc = createSyncServer(db);
  const http: Server = createServer();
  const wss = new WebSocketServer({ server: http, path: "/rpc" });
  wss.on("connection", (ws) => {
    acceptWebSocketSession(ws, rpc);
  });
  await new Promise<void>((res) => http.listen(0, "127.0.0.1", res));
  const { port } = http.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}/rpc`,
    db,
    close: async () => {
      await new Promise<void>((res) => wss.close(() => res()));
      await new Promise<void>((res) => http.close(() => res()));
      storage.close();
    },
  };
}

describe("SyncRPC over a real WebSocket", () => {
  let harness: Harness | undefined;
  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it("streams fetchChanges entries from server to client", async () => {
    harness = await startHarness();
    const provider = new SQLiteWorkspaceProvider(harness.db, { now: () => 1234 });
    provider.writeFileSync("/hello.txt", "hello");

    const client = createSyncClient({ url: harness.url });
    try {
      const stream = await client.fetchChanges({ sinceRev: 0, ignore: [] });
      const entries: ChangeEntry[] = [];
      const reader = stream.getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          entries.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      const file = entries.find((e) => e.path === "/hello.txt");
      expect(file).toBeDefined();
      expect(file?.kind).toBe("file");
      if (file?.kind === "file") {
        expect(file.size).toBe(5);
        expect(file.mtime).toBe(1234);
      }
    } finally {
      await client.close();
    }
  });
});

describe("SyncRPC push convergence", () => {
  let harness: Harness | undefined;
  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it("client pushes ChangeEntry + bytes; server converges", async () => {
    // Two DBs: A holds the pre-populated state, B is the receiver
    // we connect to over the wire. The client collects A's changes
    // and pushes them to B via push() + pushObjects().
    const senderStorage = new SQLiteTestStorage();
    const senderDb = new Database(senderStorage);
    initializeSchema(senderDb, () => 1000);
    const senderProvider = new SQLiteWorkspaceProvider(senderDb, { now: () => 1500 });
    senderProvider.writeFileSync("/a.txt", "alpha");
    senderProvider.writeFileSync("/b.txt", "beta");

    try {
      harness = await startHarness();
      const client = createSyncClient({ url: harness.url });
      try {
        // Stage every chunk the sender has into the server first,
        // then push the change list.
        const entries: ChangeEntry[] = [];
        const hashes: Uint8Array[] = [];
        const seenHash = new Set<string>();
        for await (const e of coalesceChanges(senderDb, 0)) {
          entries.push(e);
          if (e.kind === "file") {
            for (const c of e.chunks) {
              const k = Array.from(c.hash).join(",");
              if (!seenHash.has(k)) {
                seenHash.add(k);
                hashes.push(c.hash);
              }
            }
          }
        }
        // Stream bytes to the server.
        const objects = new ReadableStream<{ hash: Uint8Array; bytes: Uint8Array }>({
          async start(controller) {
            for await (const { hash, bytes } of fetchObjects(senderDb, hashes)) {
              controller.enqueue({ hash, bytes });
            }
            controller.close();
          },
        });
        await client.pushObjects(objects);

        // Push the entries. The server's push() drains the stream
        // and applies under transactionSync.
        const changes = new ReadableStream<ChangeEntry>({
          start(controller) {
            for (const e of entries) controller.enqueue(e);
            controller.close();
          },
        });
        const result = await client.push(changes);
        expect(result.rev).toBeGreaterThan(0);

        // Inspect the server DB directly through the harness handle.
        const a = harness.db.one<{ child_inode: number }>(
          "SELECT child_inode FROM vfs_dirents WHERE parent_inode = ? AND name = ?",
          ROOT_INODE,
          "a.txt",
        );
        expect(a?.child_inode).toBeGreaterThan(0);
        const b = harness.db.one<{ child_inode: number }>(
          "SELECT child_inode FROM vfs_dirents WHERE parent_inode = ? AND name = ?",
          ROOT_INODE,
          "b.txt",
        );
        expect(b?.child_inode).toBeGreaterThan(0);
      } finally {
        await client.close();
      }
    } finally {
      senderStorage.close();
    }
  });
});
