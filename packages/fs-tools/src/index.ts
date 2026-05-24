/**
 * @cloudflare/fs-tools — memory-efficient read/write/edit AI-SDK tools.
 *
 * All three tools take a {@link FileStore} so the same code drives the
 * in-memory test store, a Durable Object SQLite VFS, an SSH bridge, or
 * anything else that can serve bytes on demand.
 */

export type { FileStat, FileStore } from "./stores/types.js";
export { InMemoryFileStore } from "./stores/in-memory.js";
export { WorkspaceFileStore, type WorkspaceLike } from "./stores/workspace.js";

export { createReadTool, type ReadToolOptions } from "./tools/read.js";
export { createWriteTool, type WriteToolOptions } from "./tools/write.js";
export { createEditTool, type EditToolOptions } from "./tools/edit.js";

// Lower-level helpers, exposed for callers who want to render diffs or
// preview an edit without invoking the tool.
export {
  applyEditsToNormalizedContent,
  detectLineEnding,
  generateDiffString,
  generateUnifiedPatch,
  normalizeForFuzzyMatch,
  normalizeToLF,
  restoreLineEndings,
  stripBom,
  type AppliedEditsResult,
  type Edit,
  type EditDiffResult,
} from "./edit-diff.js";
