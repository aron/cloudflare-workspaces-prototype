// Host-side Workspace facade.
//
// Runs inside a Cloudflare Worker / Durable Object. Picks a
// backend, holds its SyncRPC stub, and exposes a thin
// fs-shaped API that the agent / DO author calls. The wire
// underneath is the same SyncRPC the bidirectional sync loop
// uses; the only difference is that reads on this side are
// one-shot RPCs (readEntry + fetchObjects) instead of the
// streaming sync loop's coalesceChanges + applyChanges.

import type { ChangeEntry } from "@cloudflare/workspace-fs";
import type { SyncRPC } from "@cloudflare/workspace-rpc";

import type { BackendHandle, WorkspaceBackend } from "./backend.js";

export interface WorkspaceOptions {
  // Backends are tried in declared order. The first one whose
  // connect() resolves wins; the rest are not consulted.
  backends: WorkspaceBackend[];
}

export class Workspace {
  readonly #backends: WorkspaceBackend[];
  #handle: BackendHandle | undefined;
  #fs: WorkspaceFs | undefined;
  #readyPromise: Promise<void> | undefined;

  constructor(options: WorkspaceOptions) {
    if (options.backends.length === 0) {
      throw new Error("Workspace requires at least one backend");
    }
    this.#backends = options.backends.slice();
  }

  // Walk the backends in declared order. Caches the first
  // successful BackendHandle so subsequent .fs / .close calls
  // reuse it. ready() is idempotent; multiple callers share
  // the same in-flight connection attempt.
  ready(): Promise<void> {
    if (this.#readyPromise) return this.#readyPromise;
    this.#readyPromise = this.#connect();
    return this.#readyPromise;
  }

  // Filesystem facade. Throws if called before ready() resolves.
  // The getter avoids a separate construction step in the
  // common pattern `await ws.ready(); ws.fs.writeFile(...)`.
  get fs(): WorkspaceFs {
    if (!this.#fs) {
      throw new Error("Workspace not connected — await ready() first");
    }
    return this.#fs;
  }

  async close(): Promise<void> {
    if (this.#handle) {
      try {
        await this.#handle.close();
      } finally {
        this.#handle = undefined;
        this.#fs = undefined;
        this.#readyPromise = undefined;
      }
    }
  }

  async #connect(): Promise<void> {
    const errors: Array<{ id: string; error: unknown }> = [];
    for (const backend of this.#backends) {
      try {
        const handle = await backend.connect();
        this.#handle = handle;
        this.#fs = new WorkspaceFs(handle.rpc);
        return;
      } catch (error) {
        errors.push({ id: backend.id, error });
      }
    }
    const summary = errors
      .map(
        ({ id, error }) => `  - ${id}: ${error instanceof Error ? error.message : String(error)}`,
      )
      .join("\n");
    throw new Error(`Workspace: no backend reachable\n${summary}`);
  }
}

// File-shaped facade over the SyncRPC stub. v1 carries the
// minimum surface the agent needs: writeFile, readFile, stat.
// readdir, rm, mkdir, and friends slot in as the call sites
// surface; the wire already has the primitives.
export class WorkspaceFs {
  readonly #rpc: SyncRPC;

  constructor(rpc: SyncRPC) {
    this.#rpc = rpc;
  }

  // Stat is the cheapest read: materialiseChange covers files,
  // dirs, and symlinks. Returns null when the path doesn't
  // exist (the caller decides whether that's an error).
  async stat(path: string): Promise<ChangeEntry | null> {
    return await this.#rpc.readEntry(path);
  }

  // readFile reassembles a file from its chunk list.
  // Two-trip protocol:
  //   1. readEntry(path)  → ChangeEntry with chunk hashes.
  //   2. fetchObjects(...) → chunk bytes by hash.
  // The chunk-hash dedup means a file we've seen before in
  // some other context is free on the wire.
  readFile(path: string): Promise<Uint8Array>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  async readFile(path: string, encoding?: "utf8"): Promise<Uint8Array | string> {
    const entry = await this.#rpc.readEntry(path);
    if (entry === null || entry.kind === "delete") {
      throw fsError("ENOENT", `no such file: ${path}`, path);
    }
    if (entry.kind !== "file") {
      throw fsError("EISDIR", `not a file: ${path}`, path);
    }
    const bytes = await this.#assembleChunks(entry.chunks);
    if (encoding === "utf8") return new TextDecoder().decode(bytes);
    return bytes;
  }

  // writeFile drives the same wire shape the sync loop uses:
  // ship the chunk bytes via pushObjects, then push a single
  // ChangeEntry through push(). The remote applies and echoes
  // back appliedPushRev; we don't assert it here because the
  // Workspace doesn't track its own pushRev counter — the
  // single push() call IS the source of truth.
  async writeFile(
    path: string,
    content: string | Uint8Array,
    options: { mode?: number } = {},
  ): Promise<void> {
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
    const mode = options.mode ?? 0o644;
    const chunks = await chunksOf(bytes);

    // Stage the chunks remotely first. The peer's pushObjects
    // lands them in vfs_blob_bytes; the subsequent push()
    // applies the entry and looks up the bytes by hash.
    if (chunks.length > 0) {
      const objects = new ReadableStream<{ hash: Uint8Array; bytes: Uint8Array }>({
        start(controller) {
          for (const c of chunks) controller.enqueue({ hash: c.hash, bytes: c.bytes });
          controller.close();
        },
      });
      await this.#rpc.pushObjects(objects);
    }

    const entry: ChangeEntry = {
      kind: "file",
      path,
      mode,
      mtime: Date.now(),
      size: bytes.byteLength,
      chunks: chunks.map((c) => ({ hash: c.hash, size: c.bytes.byteLength })),
    };
    const changes = new ReadableStream<ChangeEntry>({
      start(controller) {
        controller.enqueue(entry);
        controller.close();
      },
    });
    // senderRev: 0 marks the Workspace as an external
    // writer (not a sync peer with its own rev space).
    // The server treats the entries as local writes —
    // its outbound sync loop will ship them upstream on
    // the next tick. A sync peer would pass its own
    // currentRev here so loopback suppression kicks in;
    // the Workspace doesn't have one to share.
    await this.#rpc.push({ senderRev: 0, changes });
  }

  async #assembleChunks(chunks: { hash: Uint8Array; size: number }[]): Promise<Uint8Array> {
    if (chunks.length === 0) return new Uint8Array(0);
    const hashes = chunks.map((c) => c.hash);
    const bytesByHash = new Map<string, Uint8Array>();
    const stream = await this.#rpc.fetchObjects(hashes);
    const reader = stream.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        bytesByHash.set(hex(value.hash), value.bytes);
      }
    } finally {
      reader.releaseLock();
    }
    const total = chunks.reduce((acc, c) => acc + c.size, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      const bytes = bytesByHash.get(hex(c.hash));
      if (bytes === undefined) {
        throw fsError("EUNKNOWN_HASH", `chunk bytes missing for hash ${hex(c.hash)}`);
      }
      out.set(bytes, offset);
      offset += bytes.byteLength;
    }
    return out;
  }
}

// 512 KiB chunks — same as workspace-fs's writeFile. Keeping
// the constant in sync would be nicer but the workspace-fs
// constant isn't re-exported; cheap to redeclare here.
const CHUNK_SIZE = 512 * 1024;

async function chunksOf(bytes: Uint8Array): Promise<{ hash: Uint8Array; bytes: Uint8Array }[]> {
  const out: { hash: Uint8Array; bytes: Uint8Array }[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += CHUNK_SIZE) {
    const end = Math.min(offset + CHUNK_SIZE, bytes.byteLength);
    const slice = bytes.subarray(offset, end);
    const hash = await sha256(slice);
    out.push({ hash, bytes: slice });
  }
  // Empty input gets zero chunks; the caller emits a file
  // entry with size 0 and the read path returns an empty
  // Uint8Array. Same as workspace-fs.
  return out;
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  // crypto.subtle is the only universally-available hash
  // implementation: present in workerd, node 22+, and
  // browsers. Avoids dragging node:crypto into a workerd
  // bundle.
  // Workers types declare digest as accepting BufferSource but reject
  // a Uint8Array view onto a non-strict ArrayBuffer. Slice into a
  // fresh ArrayBuffer to satisfy the signature; the cost is one
  // copy per chunk hash, dwarfed by the network round-trip.
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const buf = await crypto.subtle.digest("SHA-256", copy.buffer as ArrayBuffer);
  return new Uint8Array(buf);
}

function hex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.byteLength; i++) s += bytes[i].toString(16).padStart(2, "0");
  return s;
}

interface FsError extends Error {
  code: string;
  path?: string;
}

function fsError(code: string, message: string, path?: string): FsError {
  const err = new Error(message) as FsError;
  err.code = code;
  if (path !== undefined) err.path = path;
  return err;
}
