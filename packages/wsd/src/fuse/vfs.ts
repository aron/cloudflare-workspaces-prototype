import {
  Database,
  initializeSchema,
  SQLiteTestStorage,
  SQLiteWorkspaceProvider,
} from "@cloudflare/workspace-fs";
import { create, type VirtualFileSystem } from "@platformatic/vfs";

export type NodeVirtualFileSystem = VirtualFileSystem;

// Spin up a node-side @platformatic/vfs instance backed by the
// workspace-fs SQLite store. The schema lives in an in-memory
// node:sqlite database; persistence would come from swapping the
// storage adapter for one that points at a file or a Durable Object.
export function createNodeVirtualFileSystem(): NodeVirtualFileSystem {
  const storage = new SQLiteTestStorage();
  const db = new Database(storage);
  initializeSchema(db, () => Date.now());
  // The VirtualProvider declaration in @platformatic/vfs is a class;
  // our provider is structurally compatible but TypeScript wants a
  // nominal match. Cast at the seam.
  return create(new SQLiteWorkspaceProvider(db) as never, { moduleHooks: false });
}
