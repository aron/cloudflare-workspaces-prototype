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
} as const;

type StatusCallback = (errnoOrBytes: number) => void;
type ResultCallback<T> = (errno: number, result: T) => void;
type NotImplementedOperation = (...args: unknown[]) => never;

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
  read(path: string, fh: number, buffer: Buffer, length: number, position: number, cb: StatusCallback): void;
  write(path: string, fh: number, buffer: Buffer, length: number, position: number, cb: StatusCallback): void;
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
  utimens: NotImplementedOperation;
  readlink: NotImplementedOperation;
  mknod: NotImplementedOperation;
  setxattr(path: string, name: string, value: Buffer, position: number, flags: number, cb: StatusCallback): void;
  getxattr(path: string, name: string, position: number, cb: StatusCallback): void;
  listxattr(path: string, cb: ResultCallback<Buffer>): void;
  removexattr(path: string, name: string, cb: StatusCallback): void;
  link: NotImplementedOperation;
  symlink: NotImplementedOperation;
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
        cb(0, statNode(vfs.statSync(path)));
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

        vfs.writeFileSync(path, Buffer.alloc(0), { mode });
        cb(0, openHandle(path));
      } catch (error) {
        cb(toErrno(error), 0);
      }
    },

    read(path, _fh, buffer, length, position, cb) {
      try {
        const data = vfs.readFileSync(path);
        const chunk = data.subarray(position, Math.min(position + length, data.length));
        chunk.copy(buffer);
        cb(chunk.length);
      } catch (error) {
        cb(toErrno(error));
      }
    },

    write(path, _fh, buffer, length, position, cb) {
      try {
        const existing = vfs.existsSync(path) ? vfs.readFileSync(path) : Buffer.alloc(0);
        const needed = position + length;
        const next = Buffer.alloc(Math.max(existing.length, needed));
        existing.copy(next);
        buffer.copy(next, position, 0, length);
        vfs.writeFileSync(path, next);
        cb(length);
      } catch (error) {
        cb(toErrno(error));
      }
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
      try {
        truncate(vfs, path, size);
        cb(0);
      } catch (error) {
        cb(toErrno(error));
      }
    },

    ftruncate(path, _fh, size, cb) {
      try {
        truncate(vfs, path, size);
        cb(0);
      } catch (error) {
        cb(toErrno(error));
      }
    },

    unlink(path, cb) {
      try {
        vfs.unlinkSync(path);
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

    chmod(_path, _mode, cb) {
      cb(0);
    },

    chown(_path, _uid, _gid, cb) {
      cb(0);
    },

    fsync(_path, _fh, _datasync, cb) {
      cb(0);
    },

    fsyncdir(_path, _fh, _datasync, cb) {
      cb(0);
    },

    utimens: notImplemented("utimens"),
    readlink: notImplemented("readlink"),
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
    symlink: notImplemented("symlink"),
  };
}

export async function mountFuse(options: { mountPoint: string; vfs: NodeVirtualFileSystem }): Promise<FuseMount> {
  const module = await import("fuse-native");
  const Fuse = module.default ?? module;
  const fuse = new Fuse(options.mountPoint, makeFUSEOps(options.vfs), {
    autoUnmount: true,
    debug: false,
  });

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

function truncate(vfs: NodeVirtualFileSystem, path: string, size: number): void {
  const existing = vfs.readFileSync(path);
  if (existing.length === size) {
    return;
  }

  const next = Buffer.alloc(size);
  existing.copy(next, 0, 0, Math.min(existing.length, size));
  vfs.writeFileSync(path, next);
}

function notImplemented(operation: string): NotImplementedOperation {
  return () => {
    throw new NotImplementedError(operation);
  };
}

function statNode(stat: { mtime: Date; atime: Date; ctime: Date; size: number; mode: number; isDirectory(): boolean }): FuseStat {
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
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
  if (code === "ENOENT") return ERRNO.ENOENT;
  if (code === "EEXIST") return ERRNO.EEXIST;
  if (code === "ENOTDIR") return ERRNO.ENOTDIR;
  if (code === "EISDIR") return ERRNO.EISDIR;
  if (code === "ENOTEMPTY") return ERRNO.ENOTEMPTY;
  if (code === "EINVAL") return ERRNO.EINVAL;
  return ERRNO.EIO;
}
