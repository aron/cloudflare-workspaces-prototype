/**
 * @cloudflare/git-tools — AI-SDK tools that drive isomorphic-git
 * against `@cloudflare/workspace`-backed filesystems.
 *
 * Trimmed during the workspace `next` port: only `gitClone` survives.
 * The previous family (gitCommit/gitPush/gitShare/gitCreateRepo/
 * gitListRepos) was built on Cloudflare Artifacts + the old
 * `@cloudflare/workspace/git` subpath, both of which were dropped in
 * the next branch. Reintroduce as needed.
 *
 * Phase-3 update: the clone now runs on the Sandbox DO via a caller-
 * supplied `cloneOnSandbox` callback. The previous `createWorkspaceVfs`
 * helper is gone — `@cloudflare/workspace/git.createGitClient` owns
 * that glue upstream.
 */

export { createGitCloneTool } from "./tools/clone.js";
export type {
  GitCloneToolOptions,
  GitCloneInvocation,
  GitCloneResult,
} from "./tools/clone.js";
