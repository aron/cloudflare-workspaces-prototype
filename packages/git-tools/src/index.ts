/**
 * @cloudflare/git-tools — AI-SDK tools that drive isomorphic-git against
 * Cloudflare Artifacts repos.
 *
 * v1 ships `gitClone` only. The package layout is shaped for a full family
 * (gitStatus, gitCommit, gitPush, gitDiff, gitLog, gitBranch); each tool
 * gets one file under `src/tools/`, and shared helpers live in
 * `src/internal/`.
 *
 * Every tool takes a small structural interface (`GitWorkspaceLike`) that
 * exposes the bits of `@cloudflare/workspace.Workspace` the tool needs
 * (Vfs, plus the Artifacts binding for clone/pull/push). Keeping the
 * dependency structural means this package can be imported by anything
 * that can produce that shape — including tests, without booting a DO.
 */

export { createGitCloneTool } from "./tools/clone.js";
export type { GitCloneToolOptions } from "./tools/clone.js";
export type { GitWorkspaceLike } from "./internal/workspace.js";
