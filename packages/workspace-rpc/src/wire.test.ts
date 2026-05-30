import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ChangeEntry } from "@cloudflare/workspace-fs";
import {
  Database,
  initializeSchema,
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
