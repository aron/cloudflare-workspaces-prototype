// SQLiteWorkspaceProvider — a @platformatic/vfs VirtualProvider backed
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
import { readlink as readlinkImpl } from "./fs/readlink.js";
import { resolveInode } from "./fs/resolve.js";
import { rm as rmImpl } from "./fs/rm.js";
import { stat as statImpl } from "./fs/stat.js";
import { symlink as symlinkImpl } from "./fs/symlink.js";
import { writeFileSync as writeFileSyncImpl } from "./fs/writeFile.js";
import { canonicalizePath } from "./path.js";
import type { Database } from "./storage.js";

export interface SQLiteWorkspaceProviderOptions {
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

interface FdState {
  path: string;
  position: number;
  readable: boolean;
  writable: boolean;
  // append mode pins every writeSync to current EOF rather than
  // honouring an explicit position argument.
  append: boolean;
}

export class SQLiteWorkspaceProvider {
  readonly db: Database;
  readonly now: () => number;

  // Capability flags consulted by @platformatic/vfs callers.
  readonly readonly = false;
  readonly supportsSymlinks = true;
  readonly supportsWatch = false;

  // Fd table. Start at 3 — 0/1/2 are reserved by convention even
  // though we don't expose them — so consumers that pass them around
  // can't accidentally collide with stdio mental models.
  #fds = new Map<number, FdState>();
  #nextFd = 3;

  constructor(db: Database, options: SQLiteWorkspaceProviderOptions = {}) {
    this.db = db;
    this.now = options.now ?? Date.now;
  }

  // -- Essential primitives ------------------------------------------

  open(path: string, flags?: string, mode?: number): Promise<number> {
    return Promise.resolve(this.openSync(path, flags, mode));
  }

  openSync(path: string, flags: string = "r", _mode?: number): number {
    const { read, write, truncate, append, create, exclusive } = parseFlags(flags);
    const existing = resolveInode(this.db, path);

    if (existing === null) {
      if (!create) {
        throw createWorkspaceError("ENOENT", `no such file: ${path}`, path);
      }
      writeFileSyncImpl(this.db, path, new Uint8Array(), {}, this.now);
    } else {
      if (existing.type !== "file") {
        throw createWorkspaceError("EISDIR", `path is a directory: ${path}`, path);
      }
      if (exclusive) {
        throw createWorkspaceError("EEXIST", `path exists: ${path}`, path);
      }
      if (truncate) {
        writeFileSyncImpl(this.db, path, new Uint8Array(), {}, this.now);
      }
    }

    const stat = statImpl(this.db, path);
    const fd = this.#nextFd++;
    this.#fds.set(fd, {
      path,
      position: append ? stat.size : 0,
      readable: read,
      writable: write,
      append,
    });
    return fd;
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

  lstatSync(path: string, _options?: { bigint?: boolean }): VirtualStatsLike {
    const node = resolveInode(this.db, path, { followSymlinks: false });
    if (node === null) {
      throw createWorkspaceError("ENOENT", `no such path: ${path}`, path);
    }
    const isSymlink = node.type === "symlink";
    const size = isSymlink
      ? (node.linkTarget ?? "").length
      : node.type === "file"
        ? (this.db.scalar<number>(
            "SELECT COALESCE(SUM(size), 0) FROM vfs_chunks WHERE inode = ?",
            node.inode,
          ) ?? 0)
        : 0;
    return wrapStats({
      mode: node.mode,
      size,
      mtimeMs: node.mtime,
      ino: node.inode,
      isFile: node.type === "file",
      isDirectory: node.type === "dir",
      isSymbolicLink: isSymlink,
    });
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

  // -- File descriptors ----------------------------------------------

  closeSync(fd: number): void {
    if (!this.#fds.delete(fd)) {
      throw createWorkspaceError("EBADF", `unknown fd ${fd}`);
    }
  }

  readSync(
    fd: number,
    buffer: Buffer | Uint8Array,
    offset: number,
    length: number,
    position: number | null,
  ): number {
    const state = this.#fdOrThrow(fd);
    if (!state.readable) {
      throw createWorkspaceError("EBADF", `fd ${fd} is not readable`);
    }
    const startAt = position ?? state.position;
    const bytes = readFileBytesSync(this.db, state.path);
    if (startAt >= bytes.byteLength) {
      return 0;
    }
    const end = Math.min(startAt + length, bytes.byteLength);
    const n = end - startAt;
    const view =
      buffer instanceof Buffer
        ? buffer
        : Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    view.set(bytes.subarray(startAt, end), offset);
    if (position === null || position === undefined) {
      state.position += n;
    }
    return n;
  }

  writeSync(
    fd: number,
    buffer: Buffer | Uint8Array,
    offset: number = 0,
    length: number = buffer.byteLength - offset,
    position: number | null = null,
  ): number {
    const state = this.#fdOrThrow(fd);
    if (!state.writable) {
      throw createWorkspaceError("EBADF", `fd ${fd} is not writable`);
    }
    const existing = readFileBytesSync(this.db, state.path);
    const startAt = state.append ? existing.byteLength : (position ?? state.position);
    const next = spliceBytes(existing, startAt, buffer, offset, length);
    writeFileSyncImpl(this.db, state.path, next, {}, this.now);
    if (position === null || position === undefined) {
      state.position = startAt + length;
    }
    return length;
  }

  fstatSync(fd: number, _options?: { bigint?: boolean }): VirtualStatsLike {
    const state = this.#fdOrThrow(fd);
    return this.statSync(state.path);
  }

  truncateSync(path: string, len: number): void {
    const node = resolveInode(this.db, path);
    if (node === null) {
      throw createWorkspaceError("ENOENT", `no such path: ${path}`, path);
    }
    if (node.type !== "file") {
      throw createWorkspaceError("EISDIR", `path is a directory: ${path}`, path);
    }
    const existing = readFileBytesSync(this.db, path);
    if (existing.byteLength === len) {
      return;
    }
    let next: Uint8Array;
    if (len < existing.byteLength) {
      next = existing.subarray(0, len);
    } else {
      next = new Uint8Array(len);
      next.set(existing, 0);
    }
    writeFileSyncImpl(this.db, path, next, {}, this.now);
  }

  ftruncateSync(fd: number, len: number): void {
    const state = this.#fdOrThrow(fd);
    this.truncateSync(state.path, len);
  }

  #fdOrThrow(fd: number): FdState {
    const state = this.#fds.get(fd);
    if (state === undefined) {
      throw createWorkspaceError("EBADF", `unknown fd ${fd}`);
    }
    return state;
  }

  // -- Symlinks ------------------------------------------------------

  readlink(path: string, _options?: { encoding?: BufferEncoding }): Promise<string> {
    return Promise.resolve(this.readlinkSync(path));
  }

  readlinkSync(path: string, _options?: { encoding?: BufferEncoding }): string {
    return readlinkImpl(this.db, path);
  }

  symlink(target: string, path: string, _type?: string): Promise<void> {
    this.symlinkSync(target, path);
    return Promise.resolve();
  }

  symlinkSync(target: string, path: string, _type?: string): void {
    symlinkImpl(this.db, target, path, this.now);
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
  return createWorkspaceError("ENOSYS", `SQLiteWorkspaceProvider.${method} is not implemented yet`);
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

interface ParsedFlags {
  read: boolean;
  write: boolean;
  create: boolean;
  truncate: boolean;
  append: boolean;
  exclusive: boolean;
}

// Translate Node's fs flag strings into the boolean flag set the fd
// table uses. Mirrors the documented behaviour of fs.open(flags) at
// https://nodejs.org/api/fs.html#file-system-flags.
function parseFlags(flags: string): ParsedFlags {
  switch (flags) {
    case "r":
      return {
        read: true,
        write: false,
        create: false,
        truncate: false,
        append: false,
        exclusive: false,
      };
    case "r+":
      return {
        read: true,
        write: true,
        create: false,
        truncate: false,
        append: false,
        exclusive: false,
      };
    case "w":
      return {
        read: false,
        write: true,
        create: true,
        truncate: true,
        append: false,
        exclusive: false,
      };
    case "w+":
      return {
        read: true,
        write: true,
        create: true,
        truncate: true,
        append: false,
        exclusive: false,
      };
    case "wx":
      return {
        read: false,
        write: true,
        create: true,
        truncate: false,
        append: false,
        exclusive: true,
      };
    case "wx+":
      return {
        read: true,
        write: true,
        create: true,
        truncate: false,
        append: false,
        exclusive: true,
      };
    case "a":
      return {
        read: false,
        write: true,
        create: true,
        truncate: false,
        append: true,
        exclusive: false,
      };
    case "a+":
      return {
        read: true,
        write: true,
        create: true,
        truncate: false,
        append: true,
        exclusive: false,
      };
    case "ax":
      return {
        read: false,
        write: true,
        create: true,
        truncate: false,
        append: true,
        exclusive: true,
      };
    case "ax+":
      return {
        read: true,
        write: true,
        create: true,
        truncate: false,
        append: true,
        exclusive: true,
      };
    default:
      throw createWorkspaceError("EINVAL", `unsupported fs flag: ${flags}`);
  }
}

// Pull a file's full content out of the chunk store into one buffer.
// Used by the fd-positional code paths because the simplest correct
// model for writeSync/truncate is "read whole file, splice, write
// whole file"; the content-addressed write path keeps untouched
// chunks deduped so this only costs the changed chunks on the wire.
function readFileBytesSync(db: Database, path: string): Uint8Array {
  const node = resolveInode(db, path);
  if (node === null) {
    throw createWorkspaceError("ENOENT", `no such file: ${path}`, path);
  }
  if (node.type !== "file") {
    throw createWorkspaceError("EISDIR", `path is a directory: ${path}`, path);
  }
  const chunks = db.all<{ hash: Uint8Array; size: number }>(
    "SELECT hash, size FROM vfs_chunks WHERE inode = ? ORDER BY idx",
    node.inode,
  );
  let total = 0;
  for (const c of chunks) total += c.size;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const chunk of chunks) {
    const row = db.one<{ bytes: Uint8Array }>(
      "SELECT bytes FROM vfs_blob_bytes WHERE hash = ?",
      chunk.hash,
    );
    if (row === undefined) {
      throw createWorkspaceError("EIO", `missing blob bytes for ${path}`, path);
    }
    out.set(row.bytes, pos);
    pos += row.bytes.byteLength;
  }
  return out;
}

// Splice `length` bytes from `src[srcOffset..]` into a copy of `dst`
// at `at`. The result is at least as long as max(dst.length, at + length).
// Bytes in `[dst.length, at)` are zero-filled (writing past EOF).
function spliceBytes(
  dst: Uint8Array,
  at: number,
  src: Uint8Array | Buffer,
  srcOffset: number,
  length: number,
): Uint8Array {
  const newLength = Math.max(dst.byteLength, at + length);
  const out = new Uint8Array(newLength);
  out.set(dst, 0);
  const srcView = src.subarray(srcOffset, srcOffset + length);
  out.set(srcView, at);
  return out;
}
