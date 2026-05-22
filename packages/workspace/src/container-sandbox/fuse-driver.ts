/**
 * fuse-native driver backed by the in-memory Vfs.
 *
 * FUSE paths are relative to the mount root: '/', '/hello.txt'
 * VFS paths include the mount prefix:       '/workspace', '/workspace/hello.txt'
 *
 * `toVfs` translates incoming FUSE paths to VFS paths. All VFS calls use VFS
 * paths; FUSE callbacks receive FUSE paths.
 */

import Fuse from 'fuse-native';
import type { Vfs } from './vfs.js';

type CB1 = (errno: number) => void;
type CB2<T> = (errno: number, result: T) => void;

function statDir() {
  const now = new Date();
  return { mtime: now, atime: now, ctime: now, size: 0, mode: 0o40755, uid: 0, gid: 0, nlink: 2 };
}
function statFile(size: number, mode: number) {
  const now = new Date();
  return { mtime: now, atime: now, ctime: now, size, mode, uid: 0, gid: 0, nlink: 1 };
}

export function makeFuseOps(vfs: Vfs, mountPoint: string) {
  const handles = new Map<number, string>();
  let nextFh = 1;

  // FUSE path '/'        → VFS path '/workspace'
  // FUSE path '/foo.txt' → VFS path '/workspace/foo.txt'
  const toVfs  = (p: string) => mountPoint + (p === '/' ? '' : p);

  return {
    readdir(path: string, cb: CB2<string[]>) {
      const vp = toVfs(path);
      if (!vfs.has(vp)) return cb(Fuse.ENOENT, []);
      cb(0, vfs.readdir(vp));
    },

    getattr(path: string, cb: CB2<object>) {
      const node = vfs.get(toVfs(path));
      if (!node) return cb(Fuse.ENOENT, null as any);
      if (node.type === 'dir')     return cb(0, statDir());
      if (node.type === 'symlink') return cb(0, statFile(node.target.length, 0o120777));
      cb(0, statFile(node.size, node.mode));
    },

    open(path: string, flags: number, cb: CB2<number>) {
      if (!vfs.has(toVfs(path))) return cb(Fuse.ENOENT, 0);
      const fh = nextFh++;
      handles.set(fh, path);
      cb(0, fh);
    },

    create(path: string, mode: number, cb: CB2<number>) {
      vfs.putFile(toVfs(path), Buffer.alloc(0), mode);
      const fh = nextFh++;
      handles.set(fh, path);
      cb(0, fh);
    },

    read(path: string, fh: number, buf: Buffer, len: number, pos: number, cb: CB1) {
      const node = vfs.get(toVfs(path));
      if (!node || node.type !== 'file') return cb(Fuse.ENOENT);
      const slice = node.buf.slice(pos, Math.min(pos + len, node.size));
      slice.copy(buf);
      cb(slice.length);
    },

    write(path: string, fh: number, buf: Buffer, len: number, pos: number, cb: CB1) {
      const written = vfs.write(toVfs(path), buf.slice(0, len), pos);
      cb(written < 0 ? Fuse.ENOENT : written);
    },

    flush(path: string, fh: number, cb: CB1) { cb(0); },

    release(path: string, fh: number, cb: CB1) {
      handles.delete(fh);
      cb(0);
    },

    truncate(path: string, size: number, cb: CB1) {
      const vp = toVfs(path);
      if (!vfs.has(vp)) return cb(Fuse.ENOENT);
      vfs.truncate(vp, size);
      cb(0);
    },

    unlink(path: string, cb: CB1) {
      const vp = toVfs(path);
      if (!vfs.has(vp)) return cb(Fuse.ENOENT);
      vfs.delete(vp);
      cb(0);
    },

    mkdir(path: string, mode: number, cb: CB1) {
      vfs.mkdir(toVfs(path), 0o40000 | mode);
      cb(0);
    },

    rmdir(path: string, cb: CB1) {
      const vp = toVfs(path);
      if (!vfs.has(vp)) return cb(Fuse.ENOENT);
      if (vfs.readdir(vp).length > 0) return cb(Fuse.ENOTEMPTY);
      vfs.delete(vp);
      cb(0);
    },

    rename(src: string, dst: string, cb: CB1) {
      if (!vfs.has(toVfs(src))) return cb(Fuse.ENOENT);
      vfs.rename(toVfs(src), toVfs(dst));
      cb(0);
    },

    fallocate(path: string, fh: number, offset: number, length: number, cb: CB1) {
      const node = vfs.get(toVfs(path));
      if (!node || node.type !== 'file') return cb(Fuse.ENOENT);
      const needed = offset + length;
      if (needed > node.buf.length) {
        let cap = Math.max(node.buf.length * 2, 64 * 1024);
        while (cap < needed) cap *= 2;
        const next = Buffer.alloc(cap);
        node.buf.copy(next, 0, 0, node.size);
        node.buf = next;
      }
      if (needed > node.size) node.size = needed;
      cb(0);
    },

    flock(path: string, fh: number, flags: number, cb: CB1) { cb(0); },

    utimens(path: string, atime: Date, mtime: Date, cb: CB1) {
      const node = vfs.get(toVfs(path));
      if (!node) return cb(Fuse.ENOENT);
      node.mtime = mtime.getTime();
      cb(0);
    },

    statfs(_path: string, cb: CB2<object>) {
      cb(0, {
        bsize: 4096, frsize: 4096,
        blocks: 1024 * 1024, bfree: 1024 * 1024, bavail: 1024 * 1024,
        files: 1024 * 1024, ffree: 1024 * 1024,
        favail: 1024 * 1024, fsid: 1, flag: 0, namemax: 255,
      });
    },

    chmod(path: string, mode: number, cb: CB1) {
      if (!vfs.chmod(toVfs(path), mode)) return cb(Fuse.ENOENT);
      cb(0);
    },

    chown(_path: string, _uid: number, _gid: number, cb: CB1) { cb(0); },

    access(path: string, _mode: number, cb: CB1) {
      cb(vfs.has(toVfs(path)) ? 0 : Fuse.ENOENT);
    },

    fsync(_path: string, _fh: number, _datasync: number, cb: CB1) { cb(0); },

    link(src: string, dst: string, cb: CB1) {
      if (!vfs.link(toVfs(src), toVfs(dst))) return cb(Fuse.ENOENT);
      cb(0);
    },

    symlink(src: string, dst: string, cb: CB1) {
      vfs.symlink(toVfs(dst), src);
      cb(0);
    },

    readlink(path: string, cb: CB2<string>) {
      const target = vfs.readlink(toVfs(path));
      if (target === null) return cb(Fuse.EINVAL, '');
      cb(0, target);
    },

    setxattr(path: string, name: string, value: Buffer, position: number, flags: number, cb: CB1) { cb(Fuse.ENOTSUP); },
    getxattr(path: string, name: string, position: number, cb: CB2<Buffer>) { cb(Fuse.ENOTSUP, null as any); },
    listxattr(path: string, cb: CB2<Buffer>) { cb(Fuse.ENOTSUP, null as any); },
    removexattr(path: string, name: string, cb: CB1) { cb(Fuse.ENOTSUP); },
  };
}

export function mount(mountPoint: string, vfs: Vfs): Promise<Fuse> {
  return new Promise((resolve, reject) => {
    const ops = makeFuseOps(vfs, mountPoint);
    const fuse: any = new Fuse(mountPoint, ops, { debug: false, autoUnmount: true, allowOther: true });

    // fuse-native (FUSE 2.9) doesn't expose big_writes / max_write / writeback_cache,
    // so we monkey-patch _fuseOptions() to append them. big_writes lets the kernel
    // batch writes up to max_write bytes per FUSE op instead of the default 4KB,
    // slashing the per-op round-trip cost for large sequential writes by ~32x.
    const origOpts = fuse._fuseOptions.bind(fuse);
    fuse._fuseOptions = () => {
      const base = origOpts();
      const extra = 'big_writes,max_write=131072,max_read=131072';
      return base ? base + ',' + extra : '-o' + extra;
    };

    const timer = setTimeout(() => reject(new Error('FUSE mount timed out after 5s')), 5000);
    fuse.mount((err: Error | null) => {
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(fuse);
    });
  });
}
