/**
 * `@cloudflare/workspace/git` — the import + isomorphic-git seam shared by
 * the `GitHubRepo` mount and the `@cloudflare/git-tools` family.
 *
 * Both consumers want the same primitive: "given an Artifacts binding and
 * a GitHub coordinate, materialize the working tree into the Vfs". That
 * primitive lives here. The day we move clone work into a Dynamic Worker
 * isolate, only this module changes.
 */

export {
  ensureBaselineRepo,
  cloneIntoVfs,
  tokenSecret,
  baselineName,
  sanitizeForRepoName,
  ensureSessionFork,
  pushToRemote,
  mintShareUrl,
  commitWorkingTree,
  sessionForkName,
  sessionWipBranch,
  parseRemoteForkName,
} from "./mounts/artifacts.js";

export type {
  ArtifactsBinding,
  ArtifactsCreateOptions,
  ArtifactsCreateRepoResult,
  ArtifactsCreateTokenResult,
  ArtifactsRepoInfo,
  ArtifactsRepoListResult,
  ArtifactsImportParams,
  ArtifactsRepo,
  EnsureBaselineOptions,
  CloneOptions,
  ForkRecord,
  ForkRegistry,
  EnsureSessionForkOptions,
  PushOptions,
  MintShareUrlOptions,
  CommitChangesOptions,
} from "./mounts/artifacts.js";

export { createVfsFs } from "./mounts/vfs-fs.js";
export type { VfsFsOptions, VfsFsPromises } from "./mounts/vfs-fs.js";
