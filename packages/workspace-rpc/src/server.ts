// Server-side adapter: a SQLite-backed Database becomes a SyncRPC.
//
// The DO uses this to expose its sync surface to the container, and
// the in-container workspace-server uses it to expose its mirror to
// the DO. Same code on both ends; what differs is who calls whom.

import {
  applyChanges,
  type ChangeEntry,
  coalesceChanges,
  currentRev,
  type Database,
  DEFAULT_IGNORE,
  fetchObjects,
  hasObjects,
  materialiseChange,
  pushObjects,
  readWatermark,
  stageBlob,
} from "@cloudflare/workspace-fs";
import { newWebSocketRpcSession, RpcTarget } from "capnweb";

import type { SyncRPC } from "./interface.js";

export interface ServerOptions {
  ignore?: string[];
  now?: () => number;
}

// Internal: a class-shaped SyncRPC. Capnweb requires RpcTarget for
// objects that travel by reference; the server object is the
// session's localMain so it never travels as a stub, but extending
// RpcTarget keeps the type machinery happy when methods return
// references that do.
class SyncRpcServer extends RpcTarget implements SyncRPC {
  constructor(
    private readonly db: Database,
    private readonly options: Required<Pick<ServerOptions, "ignore">>,
  ) {
    super();
  }

  async push(input: {
    senderRev: number;
    changes: ReadableStream<ChangeEntry>;
  }): Promise<{ rev: number; appliedPushRev: number }> {
    const entries: ChangeEntry[] = [];
    const reader = input.changes.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        entries.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    // The sender's snapshot is at `senderRev`. After we apply,
    // fetchRev = senderRev means 'we've consumed everything up
    // through that point of the sender's timeline'. We echo the
    // value back as appliedPushRev so the sender can verify on
    // every response.
    await applyChanges(this.db, entries, new Map(), {
      source: "upstream",
      advanceFetchRev: input.senderRev,
    });
    return {
      rev: currentRev(this.db),
      appliedPushRev: input.senderRev,
    };
  }

  fetchChanges(input: { sinceRev?: number; ignore?: string[] }): ReadableStream<ChangeEntry> {
    const sinceRev = input.sinceRev ?? 0;
    const ignore =
      input.ignore ?? (this.options.ignore.length > 0 ? this.options.ignore : DEFAULT_IGNORE);
    return iterableToReadableStream(coalesceChanges(this.db, sinceRev, { ignore }));
  }

  async readEntry(path: string): Promise<ChangeEntry | null> {
    return materialiseChange(this.db, path);
  }

  async currentRev(): Promise<number> {
    return currentRev(this.db);
  }

  async watermarks(): Promise<{ currentRev: number; pushRev: number; fetchRev: number }> {
    return {
      currentRev: currentRev(this.db),
      pushRev: readWatermark(this.db, "pushRev"),
      fetchRev: readWatermark(this.db, "fetchRev"),
    };
  }

  async hasObjects(hashes: Uint8Array[]): Promise<Uint8Array[]> {
    return hasObjects(this.db, hashes);
  }

  fetchObjects(hashes: Uint8Array[]): ReadableStream<{ hash: Uint8Array; bytes: Uint8Array }> {
    return iterableToReadableStream(fetchObjects(this.db, hashes));
  }

  async pushObjects(
    objects: ReadableStream<{ hash: Uint8Array; bytes: Uint8Array }>,
  ): Promise<void> {
    const reader = objects.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        stageBlob(this.db, value.hash, value.bytes, Date.now());
      }
    } finally {
      reader.releaseLock();
    }
  }
}

// Construct a SyncRPC bound to `db`. The carrier (HTTP server +
// WebSocketServer) is the caller's responsibility; this just hands
// back the object to mount on each connection via
// acceptWebSocketSession().
export function createSyncServer(db: Database, options: ServerOptions = {}): SyncRPC {
  return new SyncRpcServer(db, { ignore: options.ignore ?? [] });
}

// Attach a capnweb RPC session to a WHATWG-shaped WebSocket. The
// node `ws` package's server-side sockets implement the WHATWG
// surface (addEventListener / send / close), so this works for
// both browser-style sockets and ws-package sockets.
//
// The session is held alive by capnweb's internal event listeners
// until the socket closes; the caller can drop the return value.
export function acceptWebSocketSession(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ws: any,
  rpc: SyncRPC,
): void {
  newWebSocketRpcSession(ws, rpc as unknown as RpcTarget);
}

function iterableToReadableStream<T>(it: AsyncIterable<T>): ReadableStream<T> {
  const iterator = it[Symbol.asyncIterator]();
  return new ReadableStream<T>({
    async pull(controller) {
      const { value, done } = await iterator.next();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    async cancel(reason) {
      if (iterator.return) await iterator.return(reason as undefined);
    },
  });
}
