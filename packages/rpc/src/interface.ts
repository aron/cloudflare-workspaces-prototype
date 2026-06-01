// The wire contract for the workspace sync RPC. The DO side and the
// container-side workspace-server both implement this interface
// against a SQLite-backed VFS; the only thing that differs is which
// direction each method is called from.
//
// Naming summary:
//
//   push           — DO  → container.   Streams ChangeEntry.
//   pushObjects    — DO  → container.   Streams chunk bytes by hash.
//   fetchChanges   — DO  → container.   Streams ChangeEntry (request).
//   fetchObjects   — DO  → container.   Streams chunk bytes by hash (request).
//   hasObjects     — either probes the other. Returns the subset
//                    the receiver already holds.
//
// The exec / getExec / killExec / disposeExec surface hangs off a
// sibling ShellRPC interface. Both compose under the top-level
// WorkspaceRPC, so the wire stub exposes one stable surface while
// the two halves stay internally separable.

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
  // pushRev / fetchRev only move when the receiver is acting as
  // a sync peer. Otherwise they sit at 0.
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

// Process supervision surface. Lives alongside SyncRPC. wsd's
// Runner is the concrete implementation today; the interface keeps
// that dependency out of the wire contract.
export interface ShellRPC {
  // Spawn a command in the container. Returns an id (caller-
  // supplied or runner-minted) and a ReadableStream of ExecEvents.
  // Capnweb streams handle backpressure end-to-end; consumer-side
  // slowness propagates to the spawned process via the kernel pipe.
  exec(input: { command: string; cwd?: string; id?: string }): Promise<{
    id: string;
    events: ReadableStream<ExecEvent>;
  }>;

  // Reattach to an in-flight or recently-completed exec by id.
  // Pass `after` to resume from a known seq; "tail" yields only
  // future events; omit to receive every event from the start.
  getExec(input: { id: string; after?: number | "tail" }): Promise<{
    id: string;
    events: ReadableStream<ExecEvent>;
  }>;

  // Signal a running exec. No-op once the process has exited.
  killExec(input: {
    id: string;
    signal?: "SIGTERM" | "SIGKILL" | "SIGINT" | "SIGHUP";
  }): Promise<void>;

  // Release the event log for a completed exec. Future getExec on
  // the same id throws ENOENT.
  disposeExec(input: { id: string }): Promise<void>;
}

// Composite stub. The wire serves one of these per session; the
// two halves are independently testable. Host-side callers reach
// each via `.sync` / `.shell`.
export interface WorkspaceRPC {
  sync: SyncRPC;
  shell: ShellRPC;
}

// Every event carries a per-id monotonic `seq`. The host-side
// Workspace.shell decodes value to string when the caller passes
// `encoding: "utf8"`.
export type ExecEvent =
  | { id: string; seq: number; name: "stdout"; value: Uint8Array }
  | { id: string; seq: number; name: "stderr"; value: Uint8Array }
  | { id: string; seq: number; name: "exit"; value: number };

// Error codes carried over the wire. The client adapter rethrows as
// WorkspaceError preserving `code`, so application code can branch
// on err.code rather than parse messages.
export type WireErrorCode =
  | "ENOENT"
  | "EUNKNOWN_HASH"
  | "ESHUTDOWN"
  | "EAUTH"
  | "EPROTOCOL"
  | "EEXEC_BUSY"
  | "ELOG_TRUNCATED";

export interface WireError {
  code: WireErrorCode;
  message: string;
  detail?: unknown;
}
