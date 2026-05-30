export { detectFUSEBackend } from "./backend.js";
export { makeFUSEOps, mountFuse, NotImplementedError } from "./driver.js";
export { createNodeVirtualFileSystem } from "./vfs.js";
export type { DetectFUSEBackendOptions, FUSEBackend } from "./backend.js";
export type { FuseMount, FuseOps, FuseStat } from "./driver.js";
export type { NodeVirtualFileSystem } from "./vfs.js";
