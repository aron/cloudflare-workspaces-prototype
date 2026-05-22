/**
 * Minimal type declaration for `fuse-native`. The real package is a native
 * module installed inside the container image; locally we only need just
 * enough types for tsc to be happy when building the bundle.
 */
declare module "fuse-native" {
  type CB = (errno: number, result?: unknown) => void;

  class Fuse {
    static ENOENT:   number;
    static ENOTEMPTY: number;
    static EINVAL:   number;
    static EBADF:    number;
    static ENOSYS:   number;
    static ENOTSUP:  number;

    constructor(mountPoint: string, ops: Record<string, unknown>, opts?: Record<string, unknown>);
    mount(cb: (err: Error | null) => void): void;
    unmount(cb: (err: Error | null) => void): void;
    _fuseOptions(): string;
  }

  export default Fuse;
}
