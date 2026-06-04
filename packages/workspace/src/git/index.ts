// Public surface of @cloudflare/workspace/git.
//
// `createGitClient({ ws })` is the one entry point. It binds a
// workspace handle once and returns `{ clone, diff }` methods that
// don't repeat the workspace argument. Internally each method
// lazy-loads its optional peer deps (`isomorphic-git`, the http
// transport, and for `diff` the `diff` package) and delegates to
// `cloneWith` / `diffWith`.
//
// `cloneWith` and `diffWith` are still exported for callers that
// bring their own FsClient — tests, custom adapters, running
// against node:fs directly — but the workspace-bound path is the
// only one most consumers need.

import type { SQLiteWorkspaceProvider } from "@cloudflare/dofs";

import { type IsomorphicGitFSClient, workspaceIsomorphicGitClient } from "./adapter.js";
import { cloneWith, type GitCloneOptions, type IsomorphicGitClient } from "./clone.js";
import {
  type CreatePatchFn,
  diffWith,
  type GitDiffOptions,
  type IsomorphicGitDiffClient,
  type ReadFileFn,
} from "./diff.js";

export type { GitCloneOptions, MessageCallback, ProgressCallback } from "./clone.js";
export type { GitDiffOptions, StatusRow } from "./diff.js";

/** Duck-typed workspace handle. Only `.provider()` is required. */
export interface WorkspaceLike {
  provider(): SQLiteWorkspaceProvider;
}

/** Methods returned by `createGitClient`. */
export interface GitClient {
  /** Shallow-clone a remote into the bound workspace. */
  clone(options: GitCloneOptions): Promise<void>;
  /** Unified diff between a ref (default HEAD) and the working tree. */
  diff(options?: GitDiffOptions): Promise<string>;
}

export interface CreateGitClientOptions {
  /** Workspace whose provider backs the git operations. */
  ws: WorkspaceLike;
  /**
   * Test seam for substituting the @platformatic/vfs adapter.
   * Production callers do not pass this.
   */
  adapter?: (provider: SQLiteWorkspaceProvider) => Promise<IsomorphicGitFSClient>;
}

/**
 * Build a git client bound to a workspace.
 *
 * The FsClient is constructed lazily on first use and reused
 * across subsequent calls — `@platformatic/vfs.create()` is cheap
 * but not free, and the workspace provider is stable for the
 * lifetime of the client.
 */
export function createGitClient({
  ws,
  adapter = workspaceIsomorphicGitClient,
}: CreateGitClientOptions): GitClient {
  let fsPromise: Promise<IsomorphicGitFSClient> | undefined;
  const fs = () => {
    if (!fsPromise) fsPromise = adapter(ws.provider());
    return fsPromise;
  };

  return {
    async clone(options) {
      await cloneWith({
        ...options,
        fs: await fs(),
        git: await loadIsomorphicGit<IsomorphicGitClient>(),
        http: await loadDefaultHTTP(),
      });
    },
    async diff(options = {}) {
      const f = await fs();
      return diffWith({
        ...options,
        fs: f,
        git: await loadIsomorphicGit<IsomorphicGitDiffClient>(),
        createPatch: await loadCreatePatch(),
        readFile: readFileFrom(f),
      });
    },
  };
}

// isomorphic-git ships both named exports and a default export
// (CJS interop). Callers pull the subset they need via the generic.
async function loadIsomorphicGit<T>(): Promise<T> {
  try {
    const mod = await import("isomorphic-git");
    return (mod.default ?? mod) as unknown as T;
  } catch (cause) {
    throw new Error(
      "@cloudflare/workspace/git requires isomorphic-git as an optional peer dependency. " +
        "Install isomorphic-git.",
      { cause },
    );
  }
}

async function loadDefaultHTTP(): Promise<object> {
  try {
    const mod = await import("isomorphic-git/http/web");
    return mod.default;
  } catch (cause) {
    throw new Error("Failed to load isomorphic-git/http/web. Install isomorphic-git.", { cause });
  }
}

async function loadCreatePatch(): Promise<CreatePatchFn> {
  try {
    const mod = await import("diff");
    return mod.createPatch;
  } catch (cause) {
    throw new Error(
      "@cloudflare/workspace/git requires `diff` as an optional peer dependency. " +
        "Install `diff`.",
      { cause },
    );
  }
}

function readFileFrom(fs: IsomorphicGitFSClient): ReadFileFn {
  // `fs.promises` is typed as `object` on the public surface; the
  // underlying @platformatic/vfs handle exposes `readFile`. Narrow
  // locally rather than widening the exported type.
  const promises = fs.promises as { readFile: ReadFileFn };
  return (path) => promises.readFile(path);
}
