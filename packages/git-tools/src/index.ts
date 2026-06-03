/**
 * @cloudflare/git-tools — AI-SDK tools that drive isomorphic-git
 * against `@cloudflare/workspace`-backed filesystems.
 *
 * Trimmed during the workspace `next` port: only `gitClone` survives.
 * The previous family (gitCommit/gitPush/gitShare/gitCreateRepo/
 * gitListRepos) was built on Cloudflare Artifacts + the old
 * `@cloudflare/workspace/git` subpath, both of which were dropped in
 * the next branch. Reintroduce as needed.
 */

export { createGitCloneTool } from "./tools/clone.js";
export type { GitCloneToolOptions } from "./tools/clone.js";
export { createWorkspaceVfs } from "./tools/vfs.js";
export type { WorkspaceGitFsHandle } from "./tools/vfs.js";
