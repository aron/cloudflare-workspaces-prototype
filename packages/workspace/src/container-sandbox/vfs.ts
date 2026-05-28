/**
 * In-memory virtual filesystem.
 *
 * - `nodes`    : flat Map from absolute path → VfsNode (the source of truth).
 * - `children` : auxiliary Map from directory path → Set<childName>, so
 *                readdir/delete/rename are O(children) not O(allFiles).
 *
 * Files use a capacity / size split: `buf` is the backing storage (geometric
 * growth), `size` is the logical file length. Always slice `buf.slice(0,size)`
 * when exposing content.
 */

import { createHash } from 'node:crypto';

import { DirtyRanges } from './dirty-ranges.js';
import { CHUNK_SIZE } from '../shared/index.js';

/**
 * Every node carries a monotonic `rev` stamp . Dirty pulls
 * select by `node.rev > sinceRev`, which fixes the same-millisecond
 * race the old mtime-based watermark had. `mtime` stays on the wire
 * for display, FUSE stat, and other consumers — only the dirty-tracking
 * watermark changes.
 */
export type VfsNode =
  | { type: 'dir';     mode: number; mtime: number; rev: number }
  | {
      type: 'file';
      mode: number;
      mtime: number;
      rev: number;
      buf: Buffer;
      size: number;
      /**
       * Per-chunk SHA-256 in (idx, hash) order. `null` means the bytes
       * in that slice changed since the last hash was taken; the value
       * is recomputed lazily by `chunkHashes()`. Length is always
       * `Math.max(1, Math.ceil(size / CHUNK_SIZE))` — empty files still
       * carry one entry. .
       */
      chunkHashes: (Uint8Array | null)[];
    }
  | { type: 'symlink'; mode: number; mtime: number; rev: number; target: string };

function parentOf(path: string): string {
  return path.slice(0, path.lastIndexOf('/')) || '/';
}
function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

export class Vfs {
  private nodes = new Map<string, VfsNode>();
  private children = new Map<string, Set<string>>();
  /**
   * path → { rev, ts } for deleted nodes. `rev` is the monotonic stamp
   * used by the dirty-pull protocol ; `ts` is the wall-clock
   * timestamp kept for display and parity with the prior wire shape.
   * Cleared when a new node is created at the same path.
   */
  private tombstones = new Map<string, { rev: number; ts: number }>();
  /**
   * Monotonic revision counter. Every mutating op (mkdir, putFile,
   * symlink, link, chmod, write, truncate, rename, delete) increments
   * this exactly once and stamps the affected node(s) / tombstone(s)
   * with the new value. Pulls select by `rev > sinceRev`, which is
   * race-free under same-millisecond mtimes.
   * Suppressed while `applying === true` so remote-pushed changes
   * don't echo back on the next outbound pull.
   */
  private rev = 0;
  // While true, mutating ops do NOT advance `rev` or record tombstones —
  // used by applyChanges() so remote-pushed rows don't echo back as new
  // outbound changes on the next pull. Also suppresses dirty-range
  // recording so remote-pushed writes don't bounce back either.
  public applying = false;
  // Per-path chunk-dirty / whole-file-dirty tracker, populated by
  // putFile() (whole-file) and (eventually) by the FUSE driver's write
  // callback (range).  The bulk-pull computation uses it to decide
  // whether to ship a file's chunks or the whole file.
  public readonly dirty = new DirtyRanges();

  constructor() {
    // Root carries rev=0; it never participates in dirty pulls anyway.
    this.nodes.set('/', { type: 'dir', mode: 0o40755, mtime: Date.now(), rev: 0 });
    this.children.set('/', new Set());
  }

  /** Current monotonic revision. Advance only via bumpRev(). */
  currentRev(): number { return this.rev; }

  /**
   * Increment and return the revision. Returns the *current* value
   * when applying remote changes, so node stamps don't shift in a way
   * that would echo back on the next pull.
   */
  private bumpRev(): number {
    if (this.applying) return this.rev;
    return ++this.rev;
  }

  get(path: string): VfsNode | undefined { return this.nodes.get(path); }
  has(path: string): boolean             { return this.nodes.has(path); }

  // O(children) — uses the parent→children index
  readdir(dirPath: string): string[] {
    const set = this.children.get(dirPath);
    return set ? [...set] : [];
  }

  mkdir(path: string, mode = 0o40755): void {
    this.tombstones.delete(path);
    if (this.nodes.has(path)) return;
    this.ensureParent(path);
    this.nodes.set(path, { type: 'dir', mode, mtime: Date.now(), rev: this.bumpRev() });
    this.children.set(path, new Set());
    this.children.get(parentOf(path))!.add(basename(path));
  }

  putFile(path: string, buf: Buffer, mode = 0o100644): void {
    this.ensureParent(path);
    this.tombstones.delete(path);
    const existed = this.nodes.has(path);
    const chunkHashes = makeChunkHashSlots(buf.length);
    this.nodes.set(path, {
      type: 'file', mode, mtime: Date.now(), rev: this.bumpRev(),
      buf, size: buf.length, chunkHashes,
    });
    if (!existed) this.children.get(parentOf(path))!.add(basename(path));
    // A putFile() replaces the entire file.  Mark whole-file dirty so
    // the next pull ships every chunk.  Suppressed during applyChanges()
    // (remote-pushed writes the DO already has).
    if (!this.applying) this.dirty.recordWholeFile(path);
  }

  symlink(path: string, target: string): void {
    this.ensureParent(path);
    this.tombstones.delete(path);
    const existed = this.nodes.has(path);
    this.nodes.set(path, { type: 'symlink', mode: 0o120777, mtime: Date.now(), rev: this.bumpRev(), target });
    if (!existed) this.children.get(parentOf(path))!.add(basename(path));
  }

  readlink(path: string): string | null {
    const node = this.nodes.get(path);
    return node?.type === 'symlink' ? node.target : null;
  }

  link(src: string, dst: string): boolean {
    const node = this.nodes.get(src);
    if (!node || node.type !== 'file') return false;
    this.ensureParent(dst);
    const existed = this.nodes.has(dst);
    // Spread the source node but stamp the destination with its own
    // rev so a pull sees the new path. Copy the chunkHashes array (not
    // share by reference) so an invalidation on the source doesn't
    // bleed into the destination.
    this.nodes.set(dst, { ...node, rev: this.bumpRev(), chunkHashes: node.chunkHashes.slice() });
    if (!existed) this.children.get(parentOf(dst))!.add(basename(dst));
    return true;
  }

  chmod(path: string, mode: number): boolean {
    const node = this.nodes.get(path);
    if (!node) return false;
    node.mode = mode;
    node.rev = this.bumpRev();
    return true;
  }

  // O(children) recursive deletion. Records tombstones for every removed path
  // (unless we're in applyChanges, where the remote already knows about the
  // delete and we'd just echo it back).
  delete(path: string): void {
    if (!this.nodes.has(path)) return;
    const now = Date.now();
    const kids = this.children.get(path);
    if (kids) {
      for (const name of [...kids]) {
        this.delete(path === '/' ? '/' + name : path + '/' + name);
      }
      this.children.delete(path);
    }
    this.nodes.delete(path);
    const parent = this.children.get(parentOf(path));
    parent?.delete(basename(path));
    if (!this.applying && path !== '/') {
      // Stamp the tombstone with a fresh rev so the next dirty pull
      // sees it. Suppressed during applyChanges() so a remote-pushed
      // delete doesn't echo back.
      this.tombstones.set(path, { rev: this.bumpRev(), ts: now });
      // A locally-issued delete supersedes any pending dirty-state
      // for the path.  Suppressed during applyChanges() so a remote-
      // pushed delete doesn't wipe local dirty state we haven't pulled.
      this.dirty.clear(path);
    }
  }

  /**
   * Tombstones with rev strictly greater than `sinceRev` (:
   * pulls now select by monotonic revision, not wall-clock mtime).
   * Returns each tombstone's rev and original deletion timestamp; the
   * pull pipeline uses `rev` for ordering and `ts` for the wire-visible
   * `mtime` field on the delete record.
   */
  getTombstones(sinceRev: number): Array<{ path: string; rev: number; ts: number }> {
    const out: Array<{ path: string; rev: number; ts: number }> = [];
    for (const [path, { rev, ts }] of this.tombstones) {
      if (rev > sinceRev) out.push({ path, rev, ts });
    }
    return out;
  }

  /**
   * Drop tombstones older than `beforeRev`. Used for GC once both peers
   * have advanced past them.
   */
  pruneTombstones(beforeRev: number): number {
    let n = 0;
    for (const [path, { rev }] of this.tombstones) {
      if (rev < beforeRev) { this.tombstones.delete(path); n++; }
    }
    return n;
  }

  // FUSE write callbacks. Buffer is treated as growable capacity (geometric
  // growth) while `size` tracks the logical file length.
  write(path: string, buf: Buffer, offset: number): number {
    const node = this.nodes.get(path);
    if (!node || node.type !== 'file') return -1;
    const needed = offset + buf.length;
    if (needed > node.buf.length) {
      let cap = Math.max(node.buf.length * 2, 64 * 1024);
      while (cap < needed) cap *= 2;
      const next = Buffer.alloc(cap);
      node.buf.copy(next, 0, 0, node.size);
      node.buf = next;
    }
    buf.copy(node.buf, offset, 0, buf.length);
    if (needed > node.size) {
      node.size = needed;
      // Grow the per-chunk hash array to match the new size.
      resizeChunkHashSlots(node, needed);
    }
    // Invalidate every chunk slot the write touched. Lazy rehash on
    // the next chunkHashes() call.
    invalidateChunkHashes(node, offset, buf.length);
    node.mtime = Date.now();
    node.rev = this.bumpRev();
    // Range-dirty the touched chunks.  Suppressed during applyChanges()
    // (remote-pushed writes the DO already has).  If the path is
    // already whole-file dirty, recordRange is a no-op.
    if (!this.applying) this.dirty.recordRange(path, offset, buf.length);
    return buf.length;
  }

  truncate(path: string, size: number): void {
    const node = this.nodes.get(path);
    if (!node || node.type !== 'file') return;
    if (size > node.buf.length) {
      const next = Buffer.alloc(size);
      node.buf.copy(next, 0, 0, node.size);
      node.buf = next;
    } else if (size > node.size) {
      // Growing within existing capacity: zero-fill the new bytes so
      // the chunk-hash view reflects POSIX truncate semantics.
      node.buf.fill(0, node.size, size);
    }
    node.size = size;
    node.mtime = Date.now();
    node.rev = this.bumpRev();
    resizeChunkHashSlots(node, size);
    // Truncate may either grow (zero-fill) or shrink the file.  Without
    // a size field on the wire, the DO can't tell which trailing chunks
    // (if any) to drop, so we conservatively mark the whole file dirty.
    if (!this.applying) this.dirty.recordWholeFile(path);
  }

  rename(oldPath: string, newPath: string): void {
    if (!this.nodes.has(oldPath)) return;
    this.ensureParent(newPath);
    const now = Date.now();
    // Walk and move the entire subtree. Each moved node gets a fresh
    // rev so the new paths surface on the next pull as upserts; each
    // old path gets a tombstone so the DO mirrors the delete side of
    // the move. Suppressed in applying mode so a remote-pushed rename
    // doesn't echo back.
    const move = (oldP: string, newP: string) => {
      const node = this.nodes.get(oldP);
      if (!node) return;
      this.nodes.delete(oldP);
      this.nodes.set(newP, { ...node, rev: this.bumpRev() });
      if (!this.applying && oldP !== '/') {
        this.tombstones.set(oldP, { rev: this.bumpRev(), ts: now });
        // Clear any pending dirty state for the old path so it can't
        // leak into the next pull as a phantom upsert.
        this.dirty.clear(oldP);
      }
      const kids = this.children.get(oldP);
      if (kids) {
        this.children.delete(oldP);
        this.children.set(newP, kids);
        for (const name of [...kids]) {
          move(oldP === '/' ? '/' + name : oldP + '/' + name,
               newP === '/' ? '/' + name : newP + '/' + name);
        }
      }
    };
    move(oldPath, newPath);
    this.children.get(parentOf(oldPath))?.delete(basename(oldPath));
    this.children.get(parentOf(newPath))!.add(basename(newPath));
  }

  /**
   * Per-chunk SHA-256 view of a file. Mirrors the DO's vfs_chunks
   * (path, idx, hash, size) shape so the manifest-aware pull (ticket
   * 013 stage 3) can ship a manifest without re-walking bytes on
   * every pull. Hashes are computed lazily: write() / truncate() set
   * the affected slots to null, and this method fills them in on first
   * read.
   *
   * Length is `Math.max(1, ceil(size / CHUNK_SIZE))`. Throws if `path`
   * isn't a live file node.
   */
  chunkHashes(path: string): Uint8Array[] {
    const node = this.nodes.get(path);
    if (!node || node.type !== 'file') {
      throw new Error(`chunkHashes: not a file: ${path}`);
    }
    for (let i = 0; i < node.chunkHashes.length; i++) {
      if (node.chunkHashes[i] !== null) continue;
      const start = i * CHUNK_SIZE;
      const end   = Math.min(node.size, start + CHUNK_SIZE);
      const slice = node.buf.slice(start, end);
      const h = createHash('sha256').update(slice).digest();
      node.chunkHashes[i] = new Uint8Array(h);
    }
    return node.chunkHashes as Uint8Array[];
  }

  // Snapshot of all non-root entries
  allFiles(): Array<{ path: string; node: VfsNode }> {
    const result: Array<{ path: string; node: VfsNode }> = [];
    for (const [path, node] of this.nodes.entries()) {
      if (path !== '/') result.push({ path, node });
    }
    return result;
  }

  // Recursively ensure all ancestors exist as directories. Newly created
  // ancestors get a fresh rev so they show up on the next pull.
  private ensureParent(path: string): void {
    const parent = parentOf(path);
    if (this.nodes.has(parent)) return;
    this.ensureParent(parent);
    this.nodes.set(parent, { type: 'dir', mode: 0o40755, mtime: Date.now(), rev: this.bumpRev() });
    this.children.set(parent, new Set());
    this.children.get(parentOf(parent))!.add(basename(parent));
  }
}

/**
 * Build a fresh chunk-hash array sized for `byteLength` bytes. Every
 * slot starts as `null`; the public chunkHashes() accessor fills them
 * in lazily. Empty files still get one slot so the manifest has a
 * well-defined empty-file shape.
 */
function makeChunkHashSlots(byteLength: number): (Uint8Array | null)[] {
  const n = Math.max(1, Math.ceil(byteLength / CHUNK_SIZE));
  return new Array(n).fill(null);
}

/**
 * Resize a file node's chunk-hash array to match its current `size`.
 * Truncate or extend with nulls, and invalidate the boundary slot —
 * a truncate that lands mid-chunk changes the hash of the surviving
 * partial chunk, and a grow zero-fills the tail of the previously-last
 * chunk.
 */
function resizeChunkHashSlots(node: { size: number; chunkHashes: (Uint8Array | null)[] }, newSize: number): void {
  const oldLen = node.chunkHashes.length;
  const newLen = Math.max(1, Math.ceil(newSize / CHUNK_SIZE));
  if (newLen === oldLen) {
    // Same number of chunks; the trailing one's bytes may have changed.
    node.chunkHashes[newLen - 1] = null;
    return;
  }
  if (newLen < oldLen) {
    node.chunkHashes.length = newLen;
  } else {
    while (node.chunkHashes.length < newLen) node.chunkHashes.push(null);
  }
  // The boundary chunk's bytes are different either way.
  node.chunkHashes[newLen - 1] = null;
}

/**
 * Invalidate every chunk slot the byte range [offset, offset+length)
 * overlaps. Lazy rehash on the next chunkHashes() call.
 */
function invalidateChunkHashes(node: { chunkHashes: (Uint8Array | null)[] }, offset: number, length: number): void {
  if (length === 0) return;
  const firstIdx = Math.floor(offset / CHUNK_SIZE);
  const lastIdx  = Math.floor((offset + length - 1) / CHUNK_SIZE);
  for (let i = firstIdx; i <= lastIdx && i < node.chunkHashes.length; i++) {
    node.chunkHashes[i] = null;
  }
}
