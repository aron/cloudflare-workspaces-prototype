import { create, MemoryProvider, type VirtualFileSystem } from "@platformatic/vfs";

export type NodeVirtualFileSystem = VirtualFileSystem;

export function createNodeVirtualFileSystem(): NodeVirtualFileSystem {
  return create(new MemoryProvider(), { moduleHooks: false });
}
