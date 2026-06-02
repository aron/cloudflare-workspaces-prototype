/**
 * Vendored, slimmed-down copy of `@cloudflare/fs-tools` from the
 * `hackspace` branch. Tools/edit-diff are verbatim; the
 * `WorkspaceFileStore` is adapted to the next-branch
 * `@cloudflare/workspace` shape (see `stores/workspace.ts`).
 */
export type { FileStat, FileStore } from "./stores/types.js";
export {
  WorkspaceFileStore,
  type WorkspaceLike,
} from "./stores/workspace.js";
export { createEditTool, type EditToolOptions } from "./tools/edit.js";
export { createReadTool, type ReadToolOptions } from "./tools/read.js";
export {
  createWriteTool,
  type WriteToolOptions,
} from "./tools/write.js";
