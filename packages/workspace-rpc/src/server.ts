// Server-side adapter: a SQLite-backed Database becomes a SyncRPC.
//
// The DO uses this to expose its sync surface to the container, and
// the in-container workspace-server uses it to expose its mirror to
// the DO. Same code on both ends; what differs is who calls whom
// for which methods (the doc-level "this is DO → container" naming
// is convention, not a runtime constraint).

import {
  applyChanges,
  type ChangeEntry,
  coalesceChanges,
  currentRev,
  type Database,
  DEFAULT_IGNORE,
  fetchObjects,
  hasObjects,
  pushObjects,
  readWatermark,
  writeWatermark,
} from "@cloudflare/workspace-fs";

import type { SyncRPC } from "./interface.js";

export interface ServerOptions {
  // Path-segment ignore list applied to the wire. The container side
  // typically passes its configured list; the DO defaults to empty
  // (push from the DO carries everything by design).
  ignore?: string[];
  // Override for tests; produced via SQLite scalar otherwise.
  now?: () => number;
}

// Bind a Database to the SyncRPC surface. The returned object is
// what capnweb's newWebSocketRpcSession() consumes on the server
// side. We don't open the WebSocket here \u2014 the carrier is the
// caller's responsibility (see boot sequence in docs/07).
export function createSyncServer(db: Database, options: ServerOptions = {}): SyncRPC {
  const ignore = options.ignore ?? [];

  return {
    async push(changes) {
      // Collect chunk-byte requests as the entries flow in. The
      // server can't pull objects out of the client mid-stream
      // without a second round-trip \u2014 the wire shape is:
      //
      //   1. client streams ChangeEntry to push().
      //   2. server inspects hashes, calls back via hasObjects.
      //   3. client (a separate RPC) calls pushObjects() with the
      //      missing subset.
      //   4. push() resolves after the batch is durably applied.
      //
      // For this initial sketch we buffer all entries (small enough
      // for one Capnweb frame in the common case) and rely on a
      // separate pushObjects() call that the client makes
      // beforehand to stage the bytes in a temporary keyed store.
      // The Phase 5 implementation will switch to inline streaming
      // once capnweb's stream-receive-while-stream-send pattern is
      // wired up.
      const entries: ChangeEntry[] = [];
      const reader = changes.getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          entries.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      // The client is expected to have staged any missing bytes
      // already via a prior pushObjects() call; pull them out of
      // vfs_blob_bytes during apply.
      const objects = new Map<string, Uint8Array>();
      // applyChanges only consults the map when a file entry's
      // chunks aren't already in vfs_blob_bytes; for the staged
      // path the local hasObjects probe filled them in.
      await applyChanges(db, entries, objects, {
        advanceFetchRev: currentRev(db),
      });
      const rev = currentRev(db);
      const appliedPushRev = readWatermark(db, "fetchRev");
      return { rev, appliedPushRev };
    },

    fetchChanges({ sinceRev = 0, ignore: callerIgnore }) {
      const effective = callerIgnore ?? (ignore.length > 0 ? ignore : DEFAULT_IGNORE);
      const iter = coalesceChanges(db, sinceRev, { ignore: effective });
      return iterableToReadableStream(iter);
    },

    async hasObjects(hashes) {
      return hasObjects(db, hashes);
    },

    fetchObjects(hashes) {
      return iterableToReadableStream(fetchObjects(db, hashes));
    },

    async pushObjects(objects) {
      // Stage the bytes locally. writeFile would build a manifest
      // and a vfs_node we don't want yet; what we actually want is
      // to land the raw chunk in vfs_blob_bytes so a subsequent
      // push() apply pass can find it by hash. Phase 5 wires the
      // helper that does that without going through writeFile.
      const reader = objects.getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          // TODO(Phase 5): land { hash, bytes } directly into
          // vfs_blobs + vfs_blob_bytes. For now the sketch
          // throws so we don't silently drop bytes.
          void value;
          throw new Error("pushObjects: staging not implemented in the sketch");
        }
      } finally {
        reader.releaseLock();
      }
    },
  };

  // Suppress unused-import warning while writeWatermark is only
  // referenced by future code paths. Phase 5 deletes this.
  void writeWatermark;
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
