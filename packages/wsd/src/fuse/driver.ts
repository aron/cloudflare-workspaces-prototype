import type { FUSEBackend } from "./backend.js";
import type { NodeVirtualFileSystem } from "./vfs.js";

const ERRNO = {
  ENOENT: -2,
  EIO: -5,
  EEXIST: -17,
  ENOTDIR: -20,
  EISDIR: -21,
  EINVAL: -22,
  ENOTEMPTY: -39,
  ENODATA: -61,
  ENOSYS: -38,
} as const;

type StatusCallback = (errnoOrBytes: number) => void;
type ResultCallback<T> = (errno: number, result: T) => void;
type NotImplementedOperation = (...args: unknown[]) => void;

export class NotImplementedError extends Error {
  constructor(readonly operation: string) {
    super(`FUSE operation not implemented: ${operation}`);
    this.name = "NotImplementedError";
  }
}

export interface FuseOps {
  init(cb?: StatusCallback): void;
  error: NotImplementedOperation;
  readdir(path: string, cb: ResultCallback<string[]>): void;
  getattr(path: string, cb: ResultCallback<FuseStat | null>): void;
  fgetattr(path: string, fh: number, cb: ResultCallback<FuseStat | null>): void;
  open(path: string, flags: number, cb: ResultCallback<number>): void;
  opendir(path: string, flags: number, cb: ResultCallback<number>): void;
  create(path: string, mode: number, cb: ResultCallback<number>): void;
  read(
    path: string,
    fh: number,
    buffer: Buffer,
    length: number,
    position: number,
    cb: StatusCallback,
  ): void;
  write(
    path: string,
    fh: number,
    buffer: Buffer,
    length: number,
    position: number,
    cb: StatusCallback,
  ): void;
  release(path: string, fh: number, cb: StatusCallback): void;
  releasedir(path: string, fh: number, cb: StatusCallback): void;
  flush(path: string, fh: number, cb: StatusCallback): void;
  truncate(path: string, size: number, cb: StatusCallback): void;
  ftruncate(path: string, fh: number, size: number, cb: StatusCallback): void;
  unlink(path: string, cb: StatusCallback): void;
  mkdir(path: string, mode: number, cb: StatusCallback): void;
  rmdir(path: string, cb: StatusCallback): void;
  rename(source: string, destination: string, cb: StatusCallback): void;
  access(path: string, mode: number, cb: StatusCallback): void;
  statfs(path: string, cb: ResultCallback<Record<string, number>>): void;
  chmod(path: string, mode: number, cb: StatusCallback): void;
  chown(path: string, uid: number, gid: number, cb: StatusCallback): void;
  fsync(path: string, fh: number, datasync: number, cb: StatusCallback): void;
  fsyncdir(path: string, fh: number, datasync: number, cb: StatusCallback): void;
  utimens(path: string, atime: number, mtime: number, cb: StatusCallback): void;
  readlink(path: string, cb: ResultCallback<string>): void;
  mknod: NotImplementedOperation;
  setxattr(
    path: string,
    name: string,
    value: Buffer,
    position: number,
    flags: number,
    cb: StatusCallback,
  ): void;
  getxattr(path: string, name: string, position: number, cb: StatusCallback): void;
  listxattr(path: string, cb: ResultCallback<Buffer>): void;
  removexattr(path: string, name: string, cb: StatusCallback): void;
  link: NotImplementedOperation;
  symlink(target: string, path: string, cb: StatusCallback): void;
}

export interface FuseStat {
  mtime: Date;
  atime: Date;
  ctime: Date;
  size: number;
  mode: number;
  uid: number;
  gid: number;
  nlink: number;
}

export interface FuseMount {
  unmount(): Promise<void>;
}

export function makeFUSEOps(vfs: NodeVirtualFileSystem): FuseOps {
  const handles = new Map<number, string>();
  let nextHandle = 1;

  const openHandle = (path: string): number => {
    const handle = nextHandle++;
    handles.set(handle, path);
    return handle;
  };

  // Sidecar metadata. platformatic VFS has no chmod/chown/utimes, so we store
  // overrides here and merge them into getattr.
  interface MetaOverride {
    mode?: number;
    uid?: number;
    gid?: number;
    atime?: Date;
    mtime?: Date;
  }
  const meta = new Map<string, MetaOverride>();
  const updateMeta = (path: string, patch: MetaOverride): void => {
    meta.set(path, { ...meta.get(path), ...patch });
  };

  // Buffer-backed file content store. Sidesteps platformatic VFS's
  // whole-file readFileSync/writeFileSync cycle, which is O(N²) for
  // sequential writes. We keep an in-memory Buffer per regular file with
  // amortized doubling on growth.
  interface FileEntry {
    buf: Buffer; // capacity buffer (may be larger than size)
    size: number; // logical end-of-file
  }
  const files = new Map<string, FileEntry>();
  const ensureCapacity = (entry: FileEntry, needed: number): void => {
    if (needed <= entry.buf.length) return;
    let cap = Math.max(entry.buf.length * 2, 64 * 1024);
    while (cap < needed) cap *= 2;
    const next = Buffer.alloc(cap);
    entry.buf.copy(next, 0, 0, entry.size);
    entry.buf = next;
  };

  return {
    init(cb) {
      cb?.(0);
    },

    error: notImplemented("error"),

    readdir(path, cb) {
      try {
        cb(0, vfs.readdirSync(path));
      } catch (error) {
        cb(toErrno(error), []);
      }
    },

    getattr(path, cb) {
      try {
        const stat = statNode(vfs.lstatSync(path));
        // File content lives outside the VFS, so prefer our size.
        const entry = files.get(path);
        if (entry !== undefined) stat.size = entry.size;
        const override = meta.get(path);
        if (override) {
          if (override.mode !== undefined) {
            stat.mode = (stat.mode & 0o170000) | (override.mode & 0o7777);
          }
          if (override.uid !== undefined) stat.uid = override.uid;
          if (override.gid !== undefined) stat.gid = override.gid;
          if (override.atime) stat.atime = override.atime;
          if (override.mtime) stat.mtime = override.mtime;
        }
        cb(0, stat);
      } catch (error) {
        cb(toErrno(error), null);
      }
    },

    fgetattr(path, _fh, cb) {
      this.getattr(path, cb);
    },

    open(path, _flags, cb) {
      try {
        const stat = vfs.statSync(path);
        if (stat.isDirectory()) {
          cb(ERRNO.EISDIR, 0);
          return;
        }

        cb(0, openHandle(path));
      } catch (error) {
        cb(toErrno(error), 0);
      }
    },

    opendir(path, _flags, cb) {
      try {
        const stat = vfs.statSync(path);
        if (!stat.isDirectory()) {
          cb(ERRNO.ENOTDIR, 0);
          return;
        }

        cb(0, openHandle(path));
      } catch (error) {
        cb(toErrno(error), 0);
      }
    },

    create(path, mode, cb) {
      try {
        if (vfs.existsSync(path)) {
          cb(ERRNO.EEXIST, 0);
          return;
        }
        // Register the inode in the VFS so dir listings / stat see it,
        // but keep actual content in our buffer store.
        vfs.writeFileSync(path, Buffer.alloc(0), { mode });
        files.set(path, { buf: Buffer.alloc(0), size: 0 });
        cb(0, openHandle(path));
      } catch (error) {
        cb(toErrno(error), 0);
      }
    },

    read(path, _fh, buffer, length, position, cb) {
      let entry = files.get(path);
      if (entry === undefined) {
        // File was created out-of-band (e.g. before this driver started
        // tracking it). Lazy-hydrate from the VFS.
        try {
          const data = vfs.readFileSync(path);
          entry = { buf: data, size: data.length };
          files.set(path, entry);
        } catch (error) {
          cb(toErrno(error));
          return;
        }
      }
      if (position >= entry.size) {
        cb(0);
        return;
      }
      const end = Math.min(position + length, entry.size);
      entry.buf.copy(buffer, 0, position, end);
      cb(end - position);
    },

    write(path, _fh, buffer, length, position, cb) {
      let entry = files.get(path);
      if (entry === undefined) {
        if (!vfs.existsSync(path)) {
          cb(ERRNO.ENOENT);
          return;
        }
        entry = { buf: Buffer.alloc(0), size: 0 };
        files.set(path, entry);
      }
      const end = position + length;
      ensureCapacity(entry, end);
      buffer.copy(entry.buf, position, 0, length);
      if (end > entry.size) entry.size = end;
      cb(length);
    },

    release(_path, fh, cb) {
      handles.delete(fh);
      cb(0);
    },

    releasedir(_path, fh, cb) {
      handles.delete(fh);
      cb(0);
    },

    flush(_path, _fh, cb) {
      cb(0);
    },

    truncate(path, size, cb) {
      if (!vfs.existsSync(path)) {
        cb(ERRNO.ENOENT);
        return;
      }
      let entry = files.get(path);
      if (entry === undefined) {
        entry = { buf: Buffer.alloc(0), size: 0 };
        files.set(path, entry);
      }
      if (size > entry.size) {
        ensureCapacity(entry, size);
        entry.buf.fill(0, entry.size, size);
      }
      entry.size = size;
      cb(0);
    },

    ftruncate(path, _fh, size, cb) {
      this.truncate(path, size, cb);
    },

    unlink(path, cb) {
      try {
        vfs.unlinkSync(path);
        meta.delete(path);
        files.delete(path);
        cb(0);
      } catch (error) {
        cb(toErrno(error));
      }
    },

    mkdir(path, mode, cb) {
      try {
        vfs.mkdirSync(path, { mode });
        cb(0);
      } catch (error) {
        cb(toErrno(error));
      }
    },

    rmdir(path, cb) {
      try {
        vfs.rmdirSync(path);
        cb(0);
      } catch (error) {
        cb(toErrno(error));
      }
    },

    rename(source, destination, cb) {
      try {
        vfs.renameSync(source, destination);
        const m = meta.get(source);
        if (m !== undefined) {
          meta.delete(source);
          meta.set(destination, m);
        }
        const entry = files.get(source);
        if (entry !== undefined) {
          files.delete(source);
          files.set(destination, entry);
        }
        cb(0);
      } catch (error) {
        cb(toErrno(error));
      }
    },

    access(path, mode, cb) {
      try {
        vfs.accessSync(path, mode);
        cb(0);
      } catch (error) {
        cb(toErrno(error));
      }
    },

    statfs(_path, cb) {
      cb(0, {
        bsize: 4096,
        frsize: 4096,
        blocks: 1024 * 1024,
        bfree: 1024 * 1024,
        bavail: 1024 * 1024,
        files: 1024 * 1024,
        ffree: 1024 * 1024,
        favail: 1024 * 1024,
        fsid: 1,
        flag: 0,
        namemax: 255,
      });
    },

    chmod(path, mode, cb) {
      if (!vfs.existsSync(path)) {
        cb(ERRNO.ENOENT);
        return;
      }
      updateMeta(path, { mode });
      cb(0);
    },

    chown(path, uid, gid, cb) {
      if (!vfs.existsSync(path)) {
        cb(ERRNO.ENOENT);
        return;
      }
      updateMeta(path, { uid, gid });
      cb(0);
    },

    fsync(_path, _fh, _datasync, cb) {
      cb(0);
    },

    fsyncdir(_path, _fh, _datasync, cb) {
      cb(0);
    },

    utimens(path, atime, mtime, cb) {
      if (!vfs.existsSync(path)) {
        cb(ERRNO.ENOENT);
        return;
      }
      // Note: with libfuse2/fuse-native, touch -a / touch -m alone do not
      // reach this op — the kernel/libfuse short-circuits when only one of
      // atime/mtime is provided (UTIME_OMIT). touch with both set works.
      updateMeta(path, { atime: new Date(atime), mtime: new Date(mtime) });
      cb(0);
    },
    readlink(path, cb) {
      try {
        cb(0, vfs.readlinkSync(path));
      } catch (error) {
        cb(toErrno(error), "");
      }
    },
    mknod: notImplemented("mknod"),

    setxattr(path, _name, _value, _position, _flags, cb) {
      cb(vfs.existsSync(path) ? 0 : ERRNO.ENOENT);
    },

    getxattr(path, _name, _position, cb) {
      cb(vfs.existsSync(path) ? ERRNO.ENODATA : ERRNO.ENOENT);
    },

    listxattr(path, cb) {
      cb(vfs.existsSync(path) ? 0 : ERRNO.ENOENT, Buffer.alloc(0));
    },

    removexattr(path, _name, cb) {
      cb(vfs.existsSync(path) ? ERRNO.ENODATA : ERRNO.ENOENT);
    },

    link: notImplemented("link"),
    symlink(target, path, cb) {
      try {
        vfs.symlinkSync(target, path);
        cb(0);
      } catch (error) {
        cb(toErrno(error));
      }
    },
  };
}

export async function mountFuse(options: {
  backend?: FUSEBackend;
  mountPoint: string;
  vfs: NodeVirtualFileSystem;
}): Promise<FuseMount> {
  configureFUSEDylibPath(options.backend);
  const module = await import("fuse-native");
  const Fuse = module.default ?? module;
  const fuse = new Fuse(options.mountPoint, makeFUSEOps(options.vfs), {
    autoUnmount: true,
    debug: false,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

  // fuse-native (libfuse 2.9) doesn't expose big_writes/max_write/max_read
  // through opts, so monkey-patch _fuseOptions() to append them. big_writes
  // lets the kernel batch up to max_write bytes per FUSE op instead of the
  // default 4 KiB, cutting per-op round-trips ~32x on large sequential I/O.
  const origFuseOptions = fuse._fuseOptions.bind(fuse);
  fuse._fuseOptions = (): string => {
    const base = origFuseOptions();
    const extra = "big_writes,max_write=131072,max_read=131072";
    return base ? `${base},${extra}` : `-o${extra}`;
  };

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("FUSE mount timed out after 5s")), 5_000);
    fuse.mount((error: Error | null) => {
      clearTimeout(timer);
      if (error !== null) {
        reject(error);
        return;
      }

      resolve();
    });
  });

  return {
    unmount() {
      return new Promise<void>((resolve, reject) => {
        fuse.unmount((error: Error | null) => {
          if (error !== null) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    },
  };
}

function configureFUSEDylibPath(backend: FUSEBackend | undefined): void {
  if (backend?.kind !== "fuse-t") {
    return;
  }

  process.env.DYLD_FALLBACK_LIBRARY_PATH = prependPath(
    process.env.DYLD_FALLBACK_LIBRARY_PATH,
    backend.dylibDir,
  );
  process.env.DYLD_LIBRARY_PATH = prependPath(process.env.DYLD_LIBRARY_PATH, backend.dylibDir);
}

function prependPath(value: string | undefined, entry: string): string {
  const entries = value?.split(":").filter(Boolean) ?? [];
  return entries.includes(entry) ? entries.join(":") : [entry, ...entries].join(":");
}

const warnedOperations = new Set<string>();
function notImplemented(operation: string): NotImplementedOperation {
  return (...args: unknown[]) => {
    if (!warnedOperations.has(operation)) {
      warnedOperations.add(operation);
      console.warn(`wsd: FUSE op ${operation} not implemented; returning ENOSYS`);
    }
    const cb = args[args.length - 1];
    if (typeof cb === "function") {
      (cb as (errno: number, ...rest: unknown[]) => void)(ERRNO.ENOSYS);
    }
  };
}

function statNode(stat: {
  mtime: Date;
  atime: Date;
  ctime: Date;
  size: number;
  mode: number;
  isDirectory(): boolean;
}): FuseStat {
  return {
    mtime: stat.mtime,
    atime: stat.atime,
    ctime: stat.ctime,
    size: stat.size,
    mode: stat.mode,
    uid: typeof process.getuid === "function" ? process.getuid() : 0,
    gid: typeof process.getgid === "function" ? process.getgid() : 0,
    nlink: stat.isDirectory() ? 2 : 1,
  };
}

function toErrno(error: unknown): number {
  const code =
    typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
  if (code === "ENOENT") return ERRNO.ENOENT;
  if (code === "EEXIST") return ERRNO.EEXIST;
  if (code === "ENOTDIR") return ERRNO.ENOTDIR;
  if (code === "EISDIR") return ERRNO.EISDIR;
  if (code === "ENOTEMPTY") return ERRNO.ENOTEMPTY;
  if (code === "EINVAL") return ERRNO.EINVAL;
  return ERRNO.EIO;
}
