// The wire contract for the workspace sync RPC. The DO side and the
// container-side workspace-server both implement this interface
// against a SQLite-backed VFS; the only thing that differs is which
// direction each method is called from.
//
// Naming follows docs/02 + docs/08 of the prototype repo:
//
//   push           — DO  → container.   Streams ChangeEntry.
//   pushObjects    — DO  → container.   Streams chunk bytes by hash.
//   fetchChanges   — DO  → container.   Streams ChangeEntry (request).
//   fetchObjects   — DO  → container.   Streams chunk bytes by hash (request).
//   hasObjects     — either probes the other. Returns the subset
//                    the receiver already holds.
//
// The exec / getExec / killExec / ackExec surface from docs/08 is
// out of scope for the initial RPC sketch; this package focuses on
// the sync wire only. The exec path will land in a separate
// interface in a follow-up.

import type { ChangeEntry } from "@cloudflare/workspace-fs";

export interface SyncRPC {
  // DO → container. Stream a coalesced batch of changes. Bytes are
  // not inline: the DO sends ChangeEntry records with chunk hashes,
  // the container calls back via hasObjects / asks for the missing
  // bytes through pushObjects. Returns the container's new rev and
  // its appliedPushRev once the batch is durably applied.
  push(changes: ReadableStream<ChangeEntry>): Promise<{
    rev: number;
    appliedPushRev: number;
  }>;

  // Container ← DO. Stream every ChangeEntry with rev > sinceRev.
  // Per-file entries carry (hash, size) chunk lists; no bytes inline.
  fetchChanges(input: { sinceRev?: number; ignore?: string[] }): ReadableStream<ChangeEntry>;

  // Probe which object hashes the receiver has. Same semantics in
  // both directions: git's `have` line, batched. Returns the subset
  // of the input the receiver already holds.
  hasObjects(hashes: Uint8Array[]): Promise<Uint8Array[]>;

  // Container → DO direction of object transfer. Stream bytes for a
  // set of chunk hashes in request order. Throws EUNKNOWN_HASH if
  // any hash is unknown — callers must dedupe and probe first.
  fetchObjects(hashes: Uint8Array[]): ReadableStream<{ hash: Uint8Array; bytes: Uint8Array }>;

  // DO → container direction of object transfer. The DO streams the
  // bytes the container reported missing (via hasObjects) during a
  // push. Pushed objects are addressable immediately by hash.
  pushObjects(objects: ReadableStream<{ hash: Uint8Array; bytes: Uint8Array }>): Promise<void>;
}

// Error codes carried over the wire. The client adapter rethrows as
// WorkspaceError preserving `code`, so application code can branch
// on err.code rather than parse messages. See docs/08.
export type WireErrorCode = "ENOENT" | "EUNKNOWN_HASH" | "ESHUTDOWN" | "EAUTH" | "EPROTOCOL";

export interface WireError {
  code: WireErrorCode;
  message: string;
  detail?: unknown;
}
