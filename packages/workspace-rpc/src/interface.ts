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
  // bytes through pushObjects. `senderRev` is the sender's
  // currentRev at the moment it captured the batch — the
  // receiver advances its fetchRev to this value after the apply
  // settles, and echoes it back as `appliedPushRev` so the sender
  // can assert applied ≥ pushed on every response.
  push(input: { senderRev: number; changes: ReadableStream<ChangeEntry> }): Promise<{
    rev: number;
    appliedPushRev: number;
  }>;

  // Container ← DO. Stream every ChangeEntry with rev > sinceRev.
  // Per-file entries carry (hash, size) chunk lists; no bytes inline.
  fetchChanges(input: { sinceRev?: number; ignore?: string[] }): ReadableStream<ChangeEntry>;

  // Probe which object hashes the receiver has. Same semantics in
  // both directions: git's `have` line, batched. Returns the subset
  // of the input the receiver already holds.
  // Read the receiver's currentRev. Called by the puller before
  // a fetchChanges round so it knows the cursor to advance
  // fetchRev to once the apply settles. Cheap — one SQL
  // scalar.
  //
  // TODO(Phase 6): collapse this into fetchChanges by changing
  // the return type to { rev, stream }. One RPC instead of two,
  // and the rev is naturally consistent with the stream snapshot
  // (no race between the currentRev read and coalesceChanges).
  // Leaving the separate method in place for now because the
  // pull loop tests are easier to drive with two independent
  // RPCs; the refactor is mechanical once the loop shape settles.
  currentRev(): Promise<number>;

  // Read the receiver's full sync watermark state. Cheap (three
  // SQL scalars) and read-only. Diagnostic surface for load
  // tests, dashboards, and the agent's exec stream when it
  // wants to wait for the wire to drain. The three values are:
  //
  //   currentRev  — latest rev stamped on any local mutation.
  //   pushRev     — highest rev already shipped to the upstream.
  //   fetchRev    — highest upstream rev applied locally.
  //
  // pushRev / fetchRev only move when the sync loop is running
  // (UPSTREAM_URL configured on this peer). Otherwise they sit
  // at 0.
  watermarks(): Promise<{ currentRev: number; pushRev: number; fetchRev: number }>;

  // Materialise the receiver's view of a single path as a
  // ChangeEntry. Returns null when the path doesn't exist and
  // hasn't been tombstoned. File entries carry chunk (hash,
  // size) pairs only; the caller follows up with hasObjects +
  // fetchObjects for the bytes. Used by interactive readers
  // that don't want to drive the full fetchChanges stream just
  // to look up one path.
  readEntry(path: string): Promise<ChangeEntry | null>;

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
