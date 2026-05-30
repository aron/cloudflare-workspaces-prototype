// SqliteWorkspaceProvider — a @platformatic/vfs VirtualProvider backed
// by the workspace-fs SQLite store.
//
// Every method on VirtualProvider is declared. Methods we already have
// synchronous building blocks for delegate to the existing fs/ helpers;
// the rest throw ENOSYS so the gaps are visible at the call site.
// Subsequent commits fill in the stubs (file descriptors, positional
// I/O, truncate, symlinks, watch).

import { createWorkspaceError } from "./errors.js";
import type { MkdirOptions } from "./fs/mkdir.js";
import { mkdir as mkdirImpl } from "./fs/mkdir.js";
import { readdir as readdirImpl } from "./fs/readdir.js";
import { resolveInode } from "./fs/resolve.js";
import { rm as rmImpl } from "./fs/rm.js";
import { stat as statImpl } from "./fs/stat.js";
import { writeFileSync as writeFileSyncImpl } from "./fs/writeFile.js";
import { canonicalizePath } from "./path.js";
import type { Database } from "./storage.js";

export interface SqliteWorkspaceProviderOptions {
  // Wall-clock source. Defaults to Date.now so production callers
  // don't need to thread one through; tests pin it.
  now?: () => number;
}

interface VirtualStatsLike {
  dev: number;
  mode: number;
  nlink: number;
  uid: number;
  gid: number;
  rdev: number;
  blksize: number;
  ino: number;
  size: number;
  blocks: number;
  atimeMs: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
  atime: Date;
  mtime: Date;
  ctime: Date;
  birthtime: Date;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  isBlockDevice(): boolean;
  isCharacterDevice(): boolean;
  isFIFO(): boolean;
  isSocket(): boolean;
}

interface VirtualDirentLike {
  name: string;
  parentPath: string;
  path: string;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  isBlockDevice(): boolean;
  isCharacterDevice(): boolean;
  isFIFO(): boolean;
  isSocket(): boolean;
}

export class SqliteWorkspaceProvider {
  readonly db: Database;
  readonly now: () => number;

  // Capability flags consulted by @platformatic/vfs callers.
  readonly readonly = false;
  readonly supportsSymlinks = false;
  readonly supportsWatch = false;

  constructor(db: Database, options: SqliteWorkspaceProviderOptions = {}) {
    this.db = db;
    this.now = options.now ?? Date.now;
  }

  // -- Essential primitives ------------------------------------------

  open(_path: string, _flags?: string, _mode?: number): Promise<unknown> {
    return Promise.reject(notImplemented("open"));
  }

  openSync(_path: string, _flags?: string, _mode?: number): unknown {
    throw notImplemented("openSync");
  }

  stat(path: string, options?: { bigint?: boolean }): Promise<VirtualStatsLike> {
    return Promise.resolve(this.statSync(path, options));
  }

  statSync(path: string, _options?: { bigint?: boolean }): VirtualStatsLike {
    const s = statImpl(this.db, path);
    const node = resolveInode(this.db, path);
    const ino = node?.inode ?? 0;
    return wrapStats({
      mode: s.mode,
      size: s.size,
      mtimeMs: s.mtime,
      ino,
      isFile: s.isFile,
      isDirectory: s.isDirectory,
      isSymbolicLink: false,
    });
  }

  lstat(path: string, options?: { bigint?: boolean }): Promise<VirtualStatsLike> {
    return Promise.resolve(this.lstatSync(path, options));
  }

  lstatSync(path: string, options?: { bigint?: boolean }): VirtualStatsLike {
    // No symlinks yet, so lstat == stat. When symlinks land this method
    // will diverge to inspect the inode type directly without following.
    return this.statSync(path, options);
  }

  readdir(
    path: string,
    options?: { withFileTypes?: boolean },
  ): Promise<string[] | VirtualDirentLike[]> {
    return Promise.resolve(this.readdirSync(path, options));
  }

  readdirSync(path: string, options?: { withFileTypes?: boolean }): string[] | VirtualDirentLike[] {
    const entries = readdirImpl(this.db, path);
    if (options?.withFileTypes === true) {
      return entries.map((entry) => wrapDirent(entry));
    }
    return entries.map((entry) => entry.name);
  }

  mkdir(path: string, options?: MkdirOptions): Promise<string | undefined> {
    return Promise.resolve(this.mkdirSync(path, options));
  }

  mkdirSync(path: string, options?: MkdirOptions): string | undefined {
    mkdirImpl(this.db, path, options ?? {}, this.now);
    return undefined;
  }

  rmdir(path: string): Promise<void> {
    this.rmdirSync(path);
    return Promise.resolve();
  }

  rmdirSync(path: string): void {
    rmImpl(this.db, path, {});
  }

  unlink(path: string): Promise<void> {
    this.unlinkSync(path);
    return Promise.resolve();
  }

  unlinkSync(path: string): void {
    rmImpl(this.db, path, {});
  }

  rename(oldPath: string, newPath: string): Promise<void> {
    this.renameSync(oldPath, newPath);
    return Promise.resolve();
  }

  renameSync(oldPath: string, newPath: string): void {
    // The FS module doesn't expose rename as a standalone operation
    // yet; we lean on the existing schema-level pieces here. When
    // rename grows up (cross-directory, overwriting an existing file,
    // ...) it should move into fs/rename.ts with its own tests.
    const node = resolveInode(this.db, oldPath);
    if (node === null) {
      throw createWorkspaceError("ENOENT", `no such path: ${oldPath}`, oldPath);
    }
    const { parts, path: newCanonical } = canonicalizePath(newPath);
    if (parts.length === 0) {
      throw createWorkspaceError("EINVAL", "cannot rename onto root", newCanonical);
    }
    const newName = parts[parts.length - 1];
    const newParentPath = parts.length === 1 ? "/" : `/${parts.slice(0, -1).join("/")}`;
    const newParent = resolveInode(this.db, newParentPath);
    if (newParent === null || newParent.type !== "dir") {
      throw createWorkspaceError(
        "ENOENT",
        `parent directory missing: ${newCanonical}`,
        newCanonical,
      );
    }
    this.db.transactionSync(() => {
      this.db.run("DELETE FROM vfs_dirents WHERE child_inode = ?", node.inode);
      this.db.run(
        "INSERT INTO vfs_dirents (parent_inode, name, child_inode) VALUES (?, ?, ?)",
        newParent.inode,
        newName,
        node.inode,
      );
    });
  }

  // -- Default implementations ---------------------------------------

  readFile(
    path: string,
    options?: BufferEncoding | { encoding?: BufferEncoding | null } | null,
  ): Promise<Buffer | string> {
    return Promise.resolve(this.readFileSync(path, options));
  }

  readFileSync(
    path: string,
    options?: BufferEncoding | { encoding?: BufferEncoding | null } | null,
  ): Buffer | string {
    const node = resolveInode(this.db, path);
    if (node === null) {
      throw createWorkspaceError("ENOENT", `no such file: ${path}`, path);
    }
    if (node.type !== "file") {
      throw createWorkspaceError("EISDIR", `path is a directory: ${path}`, path);
    }
    const chunks = this.db.all<{ hash: Uint8Array; size: number }>(
      "SELECT hash, size FROM vfs_chunks WHERE inode = ? ORDER BY idx",
      node.inode,
    );
    let total = 0;
    for (const c of chunks) total += c.size;
    const out = Buffer.alloc(total);
    let offset = 0;
    for (const chunk of chunks) {
      const row = this.db.one<{ bytes: Uint8Array }>(
        "SELECT bytes FROM vfs_blob_bytes WHERE hash = ?",
        chunk.hash,
      );
      if (row === undefined) {
        throw createWorkspaceError("EIO", `missing blob bytes for ${path}`, path);
      }
      out.set(row.bytes, offset);
      offset += row.bytes.byteLength;
    }
    const encoding = typeof options === "string" ? options : options?.encoding;
    return encoding ? out.toString(encoding) : out;
  }

  writeFile(
    path: string,
    data: string | Buffer,
    options?: { encoding?: BufferEncoding; mode?: number } | BufferEncoding,
  ): Promise<void> {
    this.writeFileSync(path, data, options);
    return Promise.resolve();
  }

  writeFileSync(
    path: string,
    data: string | Buffer,
    options?: { encoding?: BufferEncoding; mode?: number } | BufferEncoding,
  ): void {
    const mode = typeof options === "string" ? undefined : options?.mode;
    const bytes =
      typeof data === "string"
        ? new TextEncoder().encode(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    writeFileSyncImpl(this.db, path, bytes, { mode }, this.now);
  }

  appendFile(
    _path: string,
    _data: string | Buffer,
    _options?: { encoding?: BufferEncoding; mode?: number } | BufferEncoding,
  ): Promise<void> {
    return Promise.reject(notImplemented("appendFile"));
  }

  appendFileSync(
    _path: string,
    _data: string | Buffer,
    _options?: { encoding?: BufferEncoding; mode?: number } | BufferEncoding,
  ): void {
    throw notImplemented("appendFileSync");
  }

  exists(path: string): Promise<boolean> {
    return Promise.resolve(this.existsSync(path));
  }

  existsSync(path: string): boolean {
    try {
      return resolveInode(this.db, path) !== null;
    } catch {
      return false;
    }
  }

  copyFile(_src: string, _dest: string, _mode?: number): Promise<void> {
    return Promise.reject(notImplemented("copyFile"));
  }

  copyFileSync(_src: string, _dest: string, _mode?: number): void {
    throw notImplemented("copyFileSync");
  }

  internalModuleStat(_path: string): number {
    // Used by node:vfs module-resolution hooks. The wsd driver doesn't
    // need it; if this provider is ever mounted via `vfs.mount()` we'll
    // need to return 0 for files, 1 for dirs, -1 for not-found.
    throw notImplemented("internalModuleStat");
  }

  realpath(path: string, _options?: { encoding?: BufferEncoding }): Promise<string> {
    return Promise.resolve(this.realpathSync(path));
  }

  realpathSync(path: string, _options?: { encoding?: BufferEncoding }): string {
    const { path: canonical } = canonicalizePath(path);
    if (resolveInode(this.db, canonical) === null) {
      throw createWorkspaceError("ENOENT", `no such path: ${canonical}`, canonical);
    }
    return canonical;
  }

  access(path: string, _mode?: number): Promise<void> {
    this.accessSync(path);
    return Promise.resolve();
  }

  accessSync(path: string, _mode?: number): void {
    if (resolveInode(this.db, path) === null) {
      throw createWorkspaceError("ENOENT", `no such path: ${path}`, path);
    }
  }

  // -- File descriptors (stubbed) ------------------------------------
  // Implemented in a follow-up commit. The provider scaffold declares
  // them all so missing surface is visible.

  closeSync(_fd: number): void {
    throw notImplemented("closeSync");
  }

  readSync(
    _fd: number,
    _buffer: Buffer | Uint8Array,
    _offset: number,
    _length: number,
    _position: number | null,
  ): number {
    throw notImplemented("readSync");
  }

  writeSync(
    _fd: number,
    _buffer: Buffer | Uint8Array,
    _offset?: number,
    _length?: number,
    _position?: number | null,
  ): number {
    throw notImplemented("writeSync");
  }

  fstatSync(_fd: number, _options?: { bigint?: boolean }): VirtualStatsLike {
    throw notImplemented("fstatSync");
  }

  truncateSync(_path: string, _len: number): void {
    throw notImplemented("truncateSync");
  }

  ftruncateSync(_fd: number, _len: number): void {
    throw notImplemented("ftruncateSync");
  }

  // -- Symlinks (stubbed) --------------------------------------------

  readlink(_path: string, _options?: { encoding?: BufferEncoding }): Promise<string> {
    return Promise.reject(notImplemented("readlink"));
  }

  readlinkSync(_path: string, _options?: { encoding?: BufferEncoding }): string {
    throw notImplemented("readlinkSync");
  }

  symlink(_target: string, _path: string, _type?: string): Promise<void> {
    return Promise.reject(notImplemented("symlink"));
  }

  symlinkSync(_target: string, _path: string, _type?: string): void {
    throw notImplemented("symlinkSync");
  }

  // -- Watch (stubbed) -----------------------------------------------

  watch(_path: string, _options?: unknown): unknown {
    throw notImplemented("watch");
  }

  watchAsync(_path: string, _options?: unknown): unknown {
    throw notImplemented("watchAsync");
  }

  watchFile(
    _path: string,
    _options?: unknown,
    _listener?: (curr: VirtualStatsLike, prev: VirtualStatsLike) => void,
  ): unknown {
    throw notImplemented("watchFile");
  }

  unwatchFile(
    _path: string,
    _listener?: (curr: VirtualStatsLike, prev: VirtualStatsLike) => void,
  ): void {
    throw notImplemented("unwatchFile");
  }
}

function notImplemented(method: string) {
  return createWorkspaceError("ENOSYS", `SqliteWorkspaceProvider.${method} is not implemented yet`);
}

// -- VirtualStats / VirtualDirent shim ------------------------------
//
// @platformatic/vfs callers (and FUSE drivers built on top) consult
// the full Node-style stat shape. Most fields don't map onto our
// content-addressed store, so they get sensible constants. The fields
// that do map \u2014 mode, size, mtime, ino \u2014 are populated for real.

interface StatsInputs {
  mode: number;
  size: number;
  mtimeMs: number;
  ino: number;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

function wrapStats(input: StatsInputs): VirtualStatsLike {
  const mtime = new Date(input.mtimeMs);
  return {
    dev: 0,
    mode: input.mode,
    nlink: 1,
    uid: 0,
    gid: 0,
    rdev: 0,
    blksize: 4096,
    ino: input.ino,
    size: input.size,
    blocks: Math.ceil(input.size / 512),
    atimeMs: input.mtimeMs,
    mtimeMs: input.mtimeMs,
    ctimeMs: input.mtimeMs,
    birthtimeMs: input.mtimeMs,
    atime: mtime,
    mtime,
    ctime: mtime,
    birthtime: mtime,
    isFile: () => input.isFile,
    isDirectory: () => input.isDirectory,
    isSymbolicLink: () => input.isSymbolicLink,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
  };
}

interface DirentInput {
  name: string;
  parentPath: string;
  isFile: boolean;
  isDirectory: boolean;
}

function wrapDirent(input: DirentInput): VirtualDirentLike {
  const fullPath =
    input.parentPath === "/" ? `/${input.name}` : `${input.parentPath}/${input.name}`;
  return {
    name: input.name,
    parentPath: input.parentPath,
    path: fullPath,
    isFile: () => input.isFile,
    isDirectory: () => input.isDirectory,
    isSymbolicLink: () => false,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
  };
}
