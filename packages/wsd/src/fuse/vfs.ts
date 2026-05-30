import { create, MemoryProvider, type VirtualFileSystem } from "node-vfs-polyfill";

export type NodeVirtualFileSystem = VirtualFileSystem;

export function createNodeVirtualFileSystem(): NodeVirtualFileSystem {
  return create(new MemoryProvider());
}
