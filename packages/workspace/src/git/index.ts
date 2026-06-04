// Public surface of @cloudflare/workspace/git.
//
// `clone()` shallow-clones a remote into a Workspace-backed VFS.
// `diff()` produces a unified diff between a ref (default HEAD)
// and the working tree.
//
// Both accept one of:
//   - `workspace`: `.provider()` is called and an FsClient is
//     built via @platformatic/vfs (loaded lazily).
//   - `fs`: a pre-built FsClient, used verbatim. Useful for
//     tests, custom adapters, or running against node:fs directly.
//
// External libraries (`isomorphic-git`, `isomorphic-git/http/web`,
// and `diff`) normally resolve from optional peer deps, but every
// dependency is injectable so tests and vendored forks don't have
// to monkey-patch the module graph.

import type { SQLiteWorkspaceProvider } from "@cloudflare/dofs";

import { type IsomorphicGitFSClient, workspaceIsomorphicGitClient } from "./adapter.js";
import {
  type CloneWithDeps,
  cloneWith,
  type GitCloneOptions,
  type IsomorphicGitClient,
} from "./clone.js";
import {
  type CreatePatchFn,
  type DiffWithDeps,
  diffWith,
  type GitDiffOptions,
  type IsomorphicGitDiffClient,
  type ReadFileFn,
} from "./diff.js";

export type { IsomorphicGitFSClient } from "./adapter.js";
export { workspaceIsomorphicGitClient } from "./adapter.js";
export type {
  GitCloneOptions,
  IsomorphicGitClient,
  MessageCallback,
  ProgressCallback,
} from "./clone.js";
export type {
  CreatePatchFn,
  GitDiffOptions,
  IsomorphicGitDiffClient,
  ReadFileFn,
  StatusRow,
} from "./diff.js";

/** Duck-typed workspace handle. Only `.provider()` is required. */
export interface WorkspaceLike {
  provider(): SQLiteWorkspaceProvider;
}

type AdapterFn = (provider: SQLiteWorkspaceProvider) => Promise<IsomorphicGitFSClient>;

type FsSource = {
  /** Pre-built FsClient. Mutually exclusive with `workspace`. */
  fs?: IsomorphicGitFSClient;
  /** Workspace handle. The adapter derives an FsClient from it. */
  workspace?: WorkspaceLike;
  /**
   * Test seam for substituting the @platformatic/vfs adapter.
   * Production callers do not pass this.
   */
  adapter?: AdapterFn;
};

export type CloneInput = GitCloneOptions &
  FsSource & {
    /** Override the isomorphic-git module (tests, vendored forks). */
    git?: IsomorphicGitClient;
    /** Override the HTTP transport. Defaults to isomorphic-git/http/web. */
    http?: object;
  };

export async function clone(input: CloneInput): Promise<void> {
  const fs = await resolveFs(input);
  const git = input.git ?? (await loadIsomorphicGit<IsomorphicGitClient>());
  const http = input.http ?? (await loadDefaultHttp());

  const {
    fs: _fs,
    workspace: _workspace,
    adapter: _adapter,
    git: _git,
    http: _http,
    ...rest
  } = input;
  void _fs;
  void _workspace;
  void _adapter;
  void _git;
  void _http;

  const deps: CloneWithDeps = { ...rest, fs, http, git };
  await cloneWith(deps);
}

export type DiffInput = GitDiffOptions &
  FsSource & {
    /** Override the isomorphic-git module. */
    git?: IsomorphicGitDiffClient;
    /** Override `createPatch`. Defaults to the `diff` package's export. */
    createPatch?: CreatePatchFn;
    /**
     * Override the function used to read working-tree files. Defaults
     * to `fs.promises.readFile`.
     */
    readFile?: ReadFileFn;
  };

export async function diff(input: DiffInput): Promise<string> {
  const fs = await resolveFs(input);
  const git = input.git ?? (await loadIsomorphicGit<IsomorphicGitDiffClient>());
  const createPatch = input.createPatch ?? (await loadCreatePatch());
  const readFile = input.readFile ?? defaultReadFile(fs);

  const deps: DiffWithDeps = {
    git,
    fs,
    createPatch,
    readFile,
    dir: input.dir,
    ref: input.ref,
  };
  return diffWith(deps);
}

async function resolveFs(input: FsSource): Promise<IsomorphicGitFSClient> {
  if (input.fs) return input.fs;
  if (input.workspace) {
    const provider = input.workspace.provider();
    const adapter = input.adapter ?? workspaceIsomorphicGitClient;
    return await adapter(provider);
  }
  throw new Error(
    "Requires either `fs` (a pre-built FsClient) or `workspace` (a handle with .provider()).",
  );
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
        "Install isomorphic-git, or pass `git` explicitly.",
      { cause },
    );
  }
}

async function loadDefaultHttp(): Promise<object> {
  try {
    const mod = await import("isomorphic-git/http/web");
    return mod.default;
  } catch (cause) {
    throw new Error(
      "Failed to load isomorphic-git/http/web. Install isomorphic-git, " +
        "or pass `http` to clone() explicitly.",
      { cause },
    );
  }
}

async function loadCreatePatch(): Promise<CreatePatchFn> {
  try {
    const mod = await import("diff");
    return mod.createPatch;
  } catch (cause) {
    throw new Error(
      "@cloudflare/workspace/git requires `diff` as an optional peer dependency to compute " +
        "patches. Install `diff`, or pass `createPatch` to diff() explicitly.",
      { cause },
    );
  }
}

function defaultReadFile(fs: IsomorphicGitFSClient): ReadFileFn {
  return (path) => fs.promises.readFile(path);
}
