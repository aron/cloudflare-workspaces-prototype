export type { DetectFUSEBackendOptions, FUSEBackend } from "./backend.js";
export { detectFUSEBackend } from "./backend.js";
export type { FuseMount, FuseOps, FuseStat } from "./driver.js";
export { makeFUSEOps, mountFuse } from "./driver.js";
export type { NodeVirtualFileSystem } from "./vfs.js";
export { createNodeVirtualFileSystem } from "./vfs.js";
