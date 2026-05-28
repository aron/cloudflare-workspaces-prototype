/**
 * Stub of the `fuse-native` package for tests that load fuse-driver.ts
 * without the native addon installed. Only the constants and shape
 * makeFuseOps() touches are populated.
 */

const Fuse = {
  ENOENT:    -2,
  EIO:       -5,
  EACCES:    -13,
  EEXIST:    -17,
  ENOTDIR:   -20,
  EISDIR:    -21,
  EINVAL:    -22,
  ENOSPC:    -28,
  ENAMETOOLONG: -36,
  ENOSYS:    -38,
  ENOTEMPTY: -39,
};

export default Fuse;
