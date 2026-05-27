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

import { DirtyRanges } from './dirty-ranges.js';

export type VfsNode =
  | { type: 'dir';     mode: number; mtime: number }
  | { type: 'file';    mode: number; mtime: number; buf: Buffer; size: number }
  | { type: 'symlink'; mode: number; mtime: number; target: string };

function parentOf(path: string): string {
  return path.slice(0, path.lastIndexOf('/')) || '/';
}
function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

export class Vfs {
  private nodes = new Map<string, VfsNode>();
  private children = new Map<string, Set<string>>();
  // path -> deletedAt timestamp. Set when a node is removed; cleared when a
  // new node is created at the same path. Surfaced via getTombstones(since).
  private tombstones = new Map<string, number>();
  // While true, delete() does NOT record tombstones. Set by applyChanges() so
  // remote-pushed deletes don't echo back on the next pull.  Also suppresses
  // dirty-range recording so remote-pushed writes don't bounce back either.
  public applying = false;
  // Per-path chunk-dirty / whole-file-dirty tracker, populated by
  // putFile() (whole-file) and (eventually) by the FUSE driver's write
  // callback (range).  The bulk-pull computation uses it to decide
  // whether to ship a file's chunks or the whole file.
  public readonly dirty = new DirtyRanges();

  constructor() {
    this.nodes.set('/', { type: 'dir', mode: 0o40755, mtime: Date.now() });
    this.children.set('/', new Set());
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
    this.nodes.set(path, { type: 'dir', mode, mtime: Date.now() });
    this.children.set(path, new Set());
    this.children.get(parentOf(path))!.add(basename(path));
  }

  putFile(path: string, buf: Buffer, mode = 0o100644): void {
    this.ensureParent(path);
    this.tombstones.delete(path);
    const existed = this.nodes.has(path);
    this.nodes.set(path, { type: 'file', mode, mtime: Date.now(), buf, size: buf.length });
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
    this.nodes.set(path, { type: 'symlink', mode: 0o120777, mtime: Date.now(), target });
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
    this.nodes.set(dst, { ...node });
    if (!existed) this.children.get(parentOf(dst))!.add(basename(dst));
    return true;
  }

  chmod(path: string, mode: number): boolean {
    const node = this.nodes.get(path);
    if (!node) return false;
    node.mode = mode;
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
      this.tombstones.set(path, now);
      // A locally-issued delete supersedes any pending dirty-state for
      // the path.  Suppressed during applyChanges() so a remote-pushed
      // delete doesn't wipe local dirty state we haven't pulled yet.
      this.dirty.clear(path);
    }
  }

  // Tombstones newer than `since` (container-local ms timestamp).
  getTombstones(since: number): Array<{ path: string; ts: number }> {
    const out: Array<{ path: string; ts: number }> = [];
    for (const [path, ts] of this.tombstones) {
      if (ts > since) out.push({ path, ts });
    }
    return out;
  }

  // Drop tombstones older than `before`. Used for GC once both peers have
  // advanced past them.
  pruneTombstones(before: number): number {
    let n = 0;
    for (const [path, ts] of this.tombstones) {
      if (ts < before) { this.tombstones.delete(path); n++; }
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
    if (needed > node.size) node.size = needed;
    node.mtime = Date.now();
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
    }
    node.size = size;
    node.mtime = Date.now();
    // Truncate may either grow (zero-fill) or shrink the file.  Without
    // a size field on the wire, the DO can't tell which trailing chunks
    // (if any) to drop, so we conservatively mark the whole file dirty.
    if (!this.applying) this.dirty.recordWholeFile(path);
  }

  rename(oldPath: string, newPath: string): void {
    if (!this.nodes.has(oldPath)) return;
    this.ensureParent(newPath);
    // Walk and move the entire subtree
    const move = (oldP: string, newP: string) => {
      const node = this.nodes.get(oldP);
      if (!node) return;
      this.nodes.delete(oldP);
      this.nodes.set(newP, node);
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

  // Snapshot of all non-root entries
  allFiles(): Array<{ path: string; node: VfsNode }> {
    const result: Array<{ path: string; node: VfsNode }> = [];
    for (const [path, node] of this.nodes.entries()) {
      if (path !== '/') result.push({ path, node });
    }
    return result;
  }

  // Recursively ensure all ancestors exist as directories
  private ensureParent(path: string): void {
    const parent = parentOf(path);
    if (this.nodes.has(parent)) return;
    this.ensureParent(parent);
    this.nodes.set(parent, { type: 'dir', mode: 0o40755, mtime: Date.now() });
    this.children.set(parent, new Set());
    this.children.get(parentOf(parent))!.add(basename(parent));
  }
}
