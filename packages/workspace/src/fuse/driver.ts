import type { MemoryVfs, VfsNode } from "./vfs.js";

const ERRNO = {
  ENOENT: -2,
  EIO: -5,
  EEXIST: -17,
  ENODATA: -61,
  EISDIR: -21,
  ENOTEMPTY: -39,
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

export function makeFuseOps(vfs: MemoryVfs): FuseOps {
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
        const node = vfs.get(path);
        if (node?.type !== "dir") {
          cb(ERRNO.ENOENT, []);
          return;
        }

        cb(0, vfs.readdir(path));
      } catch {
        cb(ERRNO.EIO, []);
      }
    },

    getattr(path, cb) {
      const node = vfs.get(path);
      if (node === undefined) {
        cb(ERRNO.ENOENT, null);
        return;
      }

      cb(0, statNode(node));
    },

    fgetattr(path, _fh, cb) {
      this.getattr(path, cb);
    },

    open(path, _flags, cb) {
      const node = vfs.get(path);
      if (node === undefined) {
        cb(ERRNO.ENOENT, 0);
        return;
      }
      if (node.type !== "file") {
        cb(ERRNO.EISDIR, 0);
        return;
      }

      cb(0, openHandle(path));
    },

    opendir(path, _flags, cb) {
      const node = vfs.get(path);
      if (node === undefined) {
        cb(ERRNO.ENOENT, 0);
        return;
      }
      if (node.type !== "dir") {
        cb(ERRNO.ENOTEMPTY, 0);
        return;
      }

      cb(0, openHandle(path));
    },

    create(path, mode, cb) {
      try {
        if (vfs.exists(path)) {
          cb(ERRNO.EEXIST, 0);
          return;
        }

        vfs.createFile(path, 0o100000 | mode);
        cb(0, openHandle(path));
      } catch {
        cb(ERRNO.ENOENT, 0);
      }
    },

    read(path, _fh, buffer, length, position, cb) {
      const chunk = vfs.read(path, length, position);
      if (chunk === undefined) {
        cb(ERRNO.ENOENT);
        return;
      }

      chunk.copy(buffer);
      cb(chunk.length);
    },

    write(path, _fh, buffer, length, position, cb) {
      const written = vfs.write(path, buffer.subarray(0, length), position);
      cb(written < 0 ? ERRNO.ENOENT : written);
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
      cb(vfs.truncate(path, size) ? 0 : ERRNO.ENOENT);
    },

    ftruncate(path, _fh, size, cb) {
      cb(vfs.truncate(path, size) ? 0 : ERRNO.ENOENT);
    },

    unlink(path, cb) {
      cb(vfs.unlink(path) ? 0 : ERRNO.ENOENT);
    },

    mkdir(path, mode, cb) {
      try {
        vfs.mkdir(path, mode);
        cb(0);
      } catch {
        cb(vfs.exists(path) ? ERRNO.EEXIST : ERRNO.ENOENT);
      }
    },

    rmdir(path, cb) {
      const result = vfs.rmdir(path);
      if (result === "ok") cb(0);
      else if (result === "not-empty") cb(ERRNO.ENOTEMPTY);
      else cb(ERRNO.ENOENT);
    },

    rename(source, destination, cb) {
      try {
        cb(vfs.rename(source, destination) ? 0 : ERRNO.ENOENT);
      } catch {
        cb(ERRNO.ENOENT);
      }
    },

    access(path, _mode, cb) {
      cb(vfs.exists(path) ? 0 : ERRNO.ENOENT);
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
      const node = vfs.get(path);
      if (node === undefined) {
        cb(ERRNO.ENOENT);
        return;
      }
      node.mode = (node.mode & 0o170000) | (mode & 0o7777);
      node.mtimeMs = Date.now();
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
      cb(vfs.exists(path) ? 0 : ERRNO.ENOENT);
    },

    getxattr(path, _name, _position, cb) {
      cb(vfs.exists(path) ? ERRNO.ENODATA : ERRNO.ENOENT);
    },

    listxattr(path, cb) {
      cb(vfs.exists(path) ? 0 : ERRNO.ENOENT, Buffer.alloc(0));
    },

    removexattr(path, _name, cb) {
      cb(vfs.exists(path) ? ERRNO.ENODATA : ERRNO.ENOENT);
    },
    link: notImplemented("link"),
    symlink: notImplemented("symlink"),
  };
}

export async function mountFuse(options: { mountPoint: string; vfs: MemoryVfs }): Promise<FuseMount> {
  const module = await import("fuse-native");
  const Fuse = module.default ?? module;
  const fuse = new Fuse(options.mountPoint, makeFuseOps(options.vfs), {
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

function notImplemented(operation: string): NotImplementedOperation {
  return () => {
    throw new NotImplementedError(operation);
  };
}

function statNode(node: VfsNode): FuseStat {
  const time = new Date(node.mtimeMs);
  return {
    mtime: time,
    atime: time,
    ctime: time,
    size: node.type === "file" ? node.size : 0,
    mode: node.mode,
    uid: typeof process.getuid === "function" ? process.getuid() : 0,
    gid: typeof process.getgid === "function" ? process.getgid() : 0,
    nlink: node.type === "dir" ? 2 : 1,
  };
}
