/**
 * Adapter exposing a workspace `Vfs` through the small subset of the
 * `node:fs/promises` surface that isomorphic-git requires.
 *
 * Methods implemented (called by isomorphic-git during clone/checkout):
 *   - readFile(path, opts?)   → returns Uint8Array or string (if encoding)
 *   - writeFile(path, data)   → bytes or string
 *   - unlink(path)
 *   - readdir(path)           → string[]
 *   - mkdir(path, opts?)      → opts.recursive supported
 *   - rmdir(path)
 *   - stat(path)              → { isFile, isDirectory, isSymbolicLink, size, mtimeMs, ctimeMs, mode }
 *   - lstat(path)             → same (we don't model symlinks)
 *   - readlink(path)          → always throws EINVAL (VFS has no symlinks)
 *   - symlink(target, path)   → writes the target path as a regular file,
 *                              emulating Git's `core.symlinks=false` mode
 *
 * Two extras on top of the standard surface that matter for clone safety:
 *
 *   1. **Path scoping.** The adapter is constructed with an absolute VFS
 *      `mountRoot`. Every path is resolved relative to (or under) that
 *      root; out-of-tree access throws EACCES. This prevents a misbehaving
 *      git impl from writing outside its mount.
 *
 *   2. **Byte budget.** Optional `maxBytes` caps the cumulative bytes
 *      written by the adapter. On overflow, `writeFile` throws `EFBIG`,
 *      isomorphic-git aborts cleanly, and the calling mount tears down
 *      the partial subtree.
 *
 * Errors are thrown as plain `Error` instances with `.code` set to the
 * usual POSIX strings (`ENOENT`, `ENOTDIR`, `EISDIR`, `EEXIST`, `EACCES`,
 * `EFBIG`) — isomorphic-git's error handling keys on `.code`.
 */

import type { Vfs } from "../vfs.js";

export interface VfsFsOptions {
  /** Root the adapter is scoped to. Absolute VFS path, no trailing slash. */
  mountRoot: string;
  /**
   * Cap on cumulative bytes written through `writeFile`. Throws EFBIG once
   * exceeded so callers can catch and tear down partial state. Default:
   * unlimited.
   */
  maxBytes?: number;
  /**
   * Tag every write with this mount root in the VFS so the workspace's
   * read-only enforcement and stub bookkeeping still apply. Defaults to
   * `mountRoot`.
   */
  provenance?: string;
}

type Mode = number;

interface VfsStats {
  isFile():           boolean;
  isDirectory():      boolean;
  isSymbolicLink():   boolean;
  size:               number;
  mtimeMs:            number;
  ctimeMs:            number;
  mode:               Mode;
  type:               "file" | "dir";
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function fsError(code: string, path: string, syscall: string): Error & { code: string; errno: number; path: string; syscall: string } {
  const err = new Error(`${code}: ${syscall} '${path}'`) as Error & { code: string; errno: number; path: string; syscall: string };
  err.code = code;
  err.errno = -1;
  err.path = path;
  err.syscall = syscall;
  return err;
}

/**
 * Build a `node:fs/promises`-shaped object that reads and writes through
 * the given Vfs, scoped to `mountRoot`.
 *
 * Returns an object with a `promises` property to match the shape
 * isomorphic-git expects (`{ fs: { promises: {...} } }`).
 */
export function createVfsFs(vfs: Vfs, opts: VfsFsOptions): { promises: VfsFsPromises; bytesWritten(): number } {
  const root = opts.mountRoot;
  const provenance = opts.provenance ?? root;
  const maxBytes = opts.maxBytes ?? Number.POSITIVE_INFINITY;
  let bytesWritten = 0;

  // Resolve `p` relative to root. Accepts both absolute paths (must start
  // with root) and root-relative ones. Rejects paths that escape root via
  // `..`.
  function resolve(p: string): string {
    const normalized = normalize(p, root);
    if (normalized !== root && !normalized.startsWith(root + "/")) {
      throw fsError("EACCES", p, "resolve");
    }
    return normalized;
  }

  function statAt(abs: string): VfsStats {
    const s = vfs.stat(abs);
    if (!s) throw fsError("ENOENT", abs, "stat");
    return {
      isFile:         () => s.type === "file",
      isDirectory:    () => s.type === "dir",
      isSymbolicLink: () => false,
      size:    s.size,
      mtimeMs: s.mtime,
      ctimeMs: s.mtime,
      mode:    s.mode,
      type:    s.type,
    };
  }

  const promises: VfsFsPromises = {
    async readFile(p: string, options?: { encoding?: string } | string): Promise<Uint8Array | string> {
      const abs = resolve(p);
      const s = vfs.stat(abs);
      if (!s) throw fsError("ENOENT", abs, "readFile");
      if (s.type !== "file") throw fsError("EISDIR", abs, "readFile");
      const bytes = vfs.readFile(abs) ?? new Uint8Array(0);
      const encoding = typeof options === "string" ? options : options?.encoding;
      return encoding ? dec.decode(bytes) : bytes;
    },

    async writeFile(p: string, data: Uint8Array | ArrayBuffer | string, _options?: unknown): Promise<void> {
      const abs = resolve(p);
      const bytes = typeof data === "string"
        ? enc.encode(data)
        : data instanceof Uint8Array
          ? data
          : new Uint8Array(data);
      if (bytesWritten + bytes.length > maxBytes) {
        throw fsError("EFBIG", abs, "writeFile");
      }
      // isomorphic-git creates directories with mkdir before writing, but
      // belt-and-braces ensure the parent exists.
      const parent = parentOf(abs);
      if (parent && parent !== root && !vfs.stat(parent)) {
        // Lazily synthesize — git writes loose objects into nested dirs.
        mkdirRecursive(parent);
      }
      vfs.writeFile(abs, bytes, 0o100644, provenance);
      bytesWritten += bytes.length;
    },

    async unlink(p: string): Promise<void> {
      const abs = resolve(p);
      const s = vfs.stat(abs);
      if (!s) throw fsError("ENOENT", abs, "unlink");
      if (s.type === "dir") throw fsError("EISDIR", abs, "unlink");
      vfs.deleteFile(abs);
    },

    async readdir(p: string): Promise<string[]> {
      const abs = resolve(p);
      const s = vfs.stat(abs);
      if (!s) throw fsError("ENOENT", abs, "readdir");
      if (s.type !== "dir") throw fsError("ENOTDIR", abs, "readdir");
      return vfs.readdir(abs).map(e => e.name).sort();
    },

    async mkdir(p: string, options?: { recursive?: boolean } | number): Promise<void> {
      const abs = resolve(p);
      const recursive = typeof options === "object" && options !== null && options.recursive === true;
      const existing = vfs.stat(abs);
      if (existing) {
        if (recursive && existing.type === "dir") return;
        throw fsError("EEXIST", abs, "mkdir");
      }
      if (recursive) {
        mkdirRecursive(abs);
      } else {
        const parent = parentOf(abs);
        if (parent && parent !== root && !vfs.stat(parent)) {
          throw fsError("ENOENT", parent, "mkdir");
        }
        vfs.mkdir(abs, 0o40755, provenance);
      }
    },

    async rmdir(p: string): Promise<void> {
      const abs = resolve(p);
      const s = vfs.stat(abs);
      if (!s) throw fsError("ENOENT", abs, "rmdir");
      if (s.type !== "dir") throw fsError("ENOTDIR", abs, "rmdir");
      // Vfs.deleteFile is recursive, but rmdir is supposed to fail on
      // non-empty dirs. isomorphic-git only calls rmdir to clean up empty
      // dirs during checkout, so we mimic the empty-dir guard.
      const kids = vfs.readdir(abs);
      if (kids.length > 0) throw fsError("ENOTEMPTY", abs, "rmdir");
      vfs.deleteFile(abs);
    },

    async stat(p: string): Promise<VfsStats> {
      return statAt(resolve(p));
    },

    async lstat(p: string): Promise<VfsStats> {
      return statAt(resolve(p));
    },

    // isomorphic-git's `bindFs` walks a fixed list of fs methods and
    // `.bind()`s each one. If any method is undefined the bind throws
    // before the clone even starts, so these stubs always exist.
    //
    // We don't model symlinks in the VFS, so `symlink(target, path)`
    // emulates Git's `core.symlinks=false` mode: write the target path
    // as a regular file's contents. That's how Git checks out repos on
    // filesystems that can't represent symlinks (Windows by default)
    // and matches the on-disk shape after a non-symlink-aware checkout.
    async readlink(p: string): Promise<string> {
      // Reading a symlink doesn't make sense when we materialize them
      // as regular files — nothing in the working tree actually IS a
      // symlink. isomorphic-git treats EINVAL as 'not a symlink'.
      throw fsError("EINVAL", resolve(p), "readlink");
    },

    async symlink(target: string, p: string): Promise<void> {
      const abs = resolve(p);
      const bytes = enc.encode(target);
      if (bytesWritten + bytes.length > maxBytes) {
        throw fsError("EFBIG", abs, "symlink");
      }
      const parent = parentOf(abs);
      if (parent && parent !== root && !vfs.stat(parent)) {
        mkdirRecursive(parent);
      }
      vfs.writeFile(abs, bytes, 0o100644, provenance);
      bytesWritten += bytes.length;
    },
  };

  function mkdirRecursive(abs: string): void {
    const segments = abs.slice(1).split("/");
    let cur = "";
    for (const seg of segments) {
      cur = cur + "/" + seg;
      const existing = vfs.stat(cur);
      if (existing && existing.type === "dir") continue;
      if (existing) throw fsError("ENOTDIR", cur, "mkdir");
      // Skip writes outside the scoped root (parents above mountRoot are
      // assumed to exist; the Workspace ensures `root` is created before
      // materialize() runs).
      if (cur !== root && !cur.startsWith(root + "/")) continue;
      vfs.mkdir(cur, 0o40755, provenance);
    }
  }

  return {
    promises,
    bytesWritten: () => bytesWritten,
  };
}

export interface VfsFsPromises {
  readFile(path: string, options?: { encoding?: string } | string): Promise<Uint8Array | string>;
  writeFile(path: string, data: Uint8Array | ArrayBuffer | string, options?: unknown): Promise<void>;
  unlink(path: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  mkdir(path: string, options?: { recursive?: boolean } | number): Promise<void>;
  rmdir(path: string): Promise<void>;
  stat(path: string): Promise<VfsStats>;
  lstat(path: string): Promise<VfsStats>;
  readlink(path: string): Promise<string>;
  symlink(target: string, path: string): Promise<void>;
}

/** Strip `..`, `.`, and duplicate slashes; resolve against `root`. */
function normalize(input: string, root: string): string {
  const startsAbsolute = input.startsWith("/");
  const base = startsAbsolute ? [] : root.slice(1).split("/").filter(Boolean);
  const parts = base.concat(input.split("/"));
  const out: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") { out.pop(); continue; }
    out.push(part);
  }
  return "/" + out.join("/");
}

function parentOf(abs: string): string {
  const idx = abs.lastIndexOf("/");
  if (idx <= 0) return "/";
  return abs.slice(0, idx);
}
