/**
 * Wire types and the RPC interface shared between the DO-side `Workspace`
 * class and the container-side server.
 */

/**
 * Size of one chunk in the chunked storage and on the chunked wire
 * format.  Both sides must agree: the DO splits writes here so each
 * row in `vfs_chunks` is at most CHUNK_SIZE bytes, and the container
 * partitions dirty file ranges into chunkIdx = floor(byteOffset / CHUNK_SIZE)
 * buckets so chunk-only pulls land on the same boundaries.
 */
export const CHUNK_SIZE = 512 * 1024;  // 512 KiB

export interface VfsEntry {
  path:    string;
  type:    "file" | "dir";
  mode:    number;
  mtime:   number;
  content?: ReadableStream<Uint8Array>;
}

export interface VfsChange {
  seq:    number;
  path:   string;
  op:     "upsert" | "delete";
  type?:  "file" | "dir";
  mode?:  number;
  mtime?: number;
  content?: ReadableStream<Uint8Array>;
}

/**
 * Lightweight VfsChange used by the bulk-pull transport.  Files come
 * back in one of two modes:
 *
 *   - **whole-file**: `contentOffset` + `contentSize` name one slice
 *     of the bulk blob holding the file's complete bytes.
 *   - **chunk-only**:  `chunks` lists the touched chunks; each entry
 *     names a slice of the bulk blob plus the chunk index inside the
 *     file (matches the DO's `vfs_chunks.idx`).  The DO merges these
 *     into its existing rows instead of rewriting the whole file.
 *
 * `chunks` and (`contentOffset`/`contentSize`) are mutually exclusive.
 * Dropping the per-file stream is what wins the round-trips inside
 * capnweb.
 */
export interface VfsChangeLite {
  seq:    number;
  path:   string;
  op:     "upsert" | "delete";
  type?:  "file" | "dir";
  mode?:  number;
  mtime?: number;
  // Whole-file mode:
  contentOffset?: number;  // byte offset into the bulk blob (files only)
  contentSize?:   number;  // byte length in the bulk blob (files only)
  // Chunk-only mode:
  chunks?: VfsChunkRef[];
}

/**
 * One chunk's slice of the bulk pull blob, plus its index inside the
 * containing file (the chunk-level VFS row's `idx`).  Always uses the
 * shared CHUNK_SIZE so the DO can apply each entry to the matching
 * `vfs_chunks` row without re-chunking.
 */
export interface VfsChunkRef {
  idx:    number;  // chunk index inside the file (0-based)
  offset: number;  // byte offset into the bulk blob
  size:   number;  // byte length in the bulk blob (<= CHUNK_SIZE)
}

/**
 * Return shape of the bulk pull: one stream for the concatenated bytes
 * of every file in `changes`, in the order those files appear.  Empty
 * blob if there are no file upserts.
 *
 * `maxRev` is the container-side monotonic revision the receiver should
 * adopt after a successful apply . It equals `since` when
 * nothing changed and `vfs.currentRev()` when changes were collected;
 * either way, advancing to `maxRev` makes the next pull strictly after.
 */
export interface DirtyBulk {
  changes: VfsChangeLite[];
  blob:    ReadableStream<Uint8Array>;
  maxRev:  number;
}

// ---- : manifest-aware pull -----------------------

/**
 * One chunk in a file's manifest: its sha256 hash and byte length.
 * Order in the surrounding `chunks` array is the chunk index in the
 * file. No offsets — unlike VfsChunkRef, manifests are byte-free on
 * the wire; the receiver fetches missing blobs out-of-band via
 * `getBlobs(hashes)`.
 */
export interface ManifestChunk {
  hash: Uint8Array;  // 32-byte sha256(chunk_bytes)
  size: number;      // <= CHUNK_SIZE; last chunk may be shorter
}

/**
 * Manifest-aware change record. Files carry `chunks` (the ordered
 * (hash, size) list); dirs carry just mode/mtime; deletes carry just
 * the path. Drop-in replacement for VfsChangeLite on the stage-3 wire.
 */
export interface ManifestChange {
  seq:    number;
  path:   string;
  op:     "upsert" | "delete";
  type?:  "file" | "dir";
  mode?:  number;
  mtime?: number;
  chunks?: ManifestChunk[];
}

/**
 * Stage-3 pull return shape. No blob; the receiver computes its
 * missing set via `hasBlobs(union of chunk hashes)` and streams it
 * back via `getBlobs(missing)`.
 */
export interface ManifestBulk {
  changes: ManifestChange[];
  maxRev:  number;
}

export interface FileStat {
  type:  "file" | "dir";
  mode:  number;
  mtime: number;
  size:  number;
}

export interface GrepHit {
  path: string;
  line: number;
  text: string;
}

export interface ExecResult {
  exitCode: number;
  stdout:   string;
  stderr:   string;
  pushed:   number;  // # of changes uploaded to the container before the command
  pulled:   number;  // # of changes downloaded after the command
}

export interface ExecOptions {
  cwd?: string;
}

/**
 * The RPC surface the container server exposes over capnweb.
 * Both sides must agree on this shape exactly.
 */
export interface ContainerRpc {
  snapshot():                                        Promise<{ entries: VfsEntry[]; seq: number }>;
  applyChanges(changes: VfsChange[]):                Promise<{ seq: number }>;
  /**
   * Return every node and tombstone with rev strictly greater than
   * `sinceRev` (: monotonic container-side revision). The
   * parameter is unchanged on the wire but the semantics moved from
   * wall-clock mtime to revision; the no-FUSE fallback retains mtime
   * selection for dev/test only.
   */
  getDirtyNodes(sinceRev?: number, ignore?: string[]):  Promise<VfsChange[]>;
  /**
   * Bulk pull: lightweight metadata records plus a single byte stream
   * holding every file's content concatenated.  Cuts capnweb's
   * per-stream round-trips down to one stream total.  `sinceRev` and
   * `DirtyBulk.maxRev` use the monotonic-revision protocol .
   */
  pullDirty(sinceRev?: number, ignore?: string[]):      Promise<DirtyBulk>;
  /**
   * Manifest-aware pull . Returns one record per
   * dirty path with a `chunks: (hash, size)[]` array instead of inline
   * bytes. The caller follows up with `hasBlobs` + `getBlobs` for the
   * subset of chunk hashes it doesn't already have. Identical content
   * at multiple paths is one entry per blob hash on the wire.
   */
  pullDirtyV2(sinceRev?: number, ignore?: string[]):    Promise<ManifestBulk>;
  /**
   * Given a list of chunk hashes, return the subset the container has
   * stored. Used by the manifest-aware pull and by the chunk-mode push
   * (DO -> container).
   */
  hasBlobs(hashes: Uint8Array[]):                       Promise<Uint8Array[]>;
  /**
   * Return the bytes for each hash, in request order. Throws if any
   * hash isn't present — callers must dedupe and probe via hasBlobs
   * first.
   */
  getBlobs(hashes: Uint8Array[]):                       Promise<Uint8Array[]>;
  exec(command: string, cwd?: string):               Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

/**
 * Directory-aware path containment check.
 *
 * Returns true iff `path` is either exactly `dir` or a descendant of it.
 * Unlike a raw `path.startsWith(dir)`, this rejects sibling-prefix matches
 * such as `/workspace/foobar` being treated as a child of `/workspace/foo`.
 *
 * Trailing slashes on `dir` are normalized away so `/workspace/foo` and
 * `/workspace/foo/` are equivalent. The root `/` is the only directory
 * where the trailing slash is part of its identity.
 *
 * The check is purely lexical; neither argument is canonicalized here.
 * Callers that accept untrusted input should canonicalize first (see
 *).
 */
export function pathStartsWith(path: string, dir: string): boolean {
  const base = dir.length > 1 && dir.endsWith("/") ? dir.slice(0, -1) : dir;
  if (path === base) return true;
  const prefix = base === "/" ? "/" : base + "/";
  return path.startsWith(prefix);
}
