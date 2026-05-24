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

export { createGitCreateRepoTool } from "./tools/create-repo.js";
export type { GitCreateRepoToolOptions } from "./tools/create-repo.js";

export { createGitCommitTool } from "./tools/commit.js";
export type { GitCommitToolOptions } from "./tools/commit.js";

export { createGitPushTool } from "./tools/push.js";
export type { GitPushToolOptions } from "./tools/push.js";

export { createGitShareTool } from "./tools/share.js";
export type { GitShareToolOptions } from "./tools/share.js";

export type { GitWorkspaceLike } from "./internal/workspace.js";
