// Public surface of @cloudflare/workspace/git.
//
// `clone()` is the one-call entry point. Two flavours of `fs`
// sourcing:
//
//   - `workspace`: `.provider()` is called and an FsClient is
//     built via @platformatic/vfs (loaded lazily).
//   - `fs`: a pre-built FsClient, used verbatim. Useful for
//     tests, custom adapters, or running against node:fs directly.
//
// `git` and `http` normally resolve from the optional
// `isomorphic-git` peer dep, but both are injectable so tests and
// vendored forks don't have to monkey-patch the module graph.

import type { SQLiteWorkspaceProvider } from "@cloudflare/dofs";

import { type IsomorphicGitFSClient, workspaceIsomorphicGitClient } from "./adapter.js";
import {
  type CloneWithDeps,
  cloneWith,
  type GitCloneOptions,
  type IsomorphicGitClient,
} from "./clone.js";

export type { IsomorphicGitFSClient } from "./adapter.js";
export { workspaceIsomorphicGitClient } from "./adapter.js";
export type {
  GitCloneOptions,
  IsomorphicGitClient,
  MessageCallback,
  ProgressCallback,
} from "./clone.js";

/** Duck-typed workspace handle. Only `.provider()` is required. */
export interface WorkspaceLike {
  provider(): SQLiteWorkspaceProvider;
}

export type CloneInput = GitCloneOptions & {
  /** Pre-built FsClient. Mutually exclusive with `workspace`. */
  fs?: IsomorphicGitFSClient;
  /** Workspace handle. The adapter derives an FsClient from it. */
  workspace?: WorkspaceLike;
  /** Override the isomorphic-git module (tests, vendored forks). */
  git?: IsomorphicGitClient;
  /** Override the HTTP transport. Defaults to isomorphic-git/http/web. */
  http?: object;
  /**
   * Test seam for substituting the @platformatic/vfs adapter.
   * Production callers do not pass this.
   */
  adapter?: (provider: SQLiteWorkspaceProvider) => Promise<IsomorphicGitFSClient>;
};

export async function clone(input: CloneInput): Promise<void> {
  const fs = await resolveFs(input);
  const git = input.git ?? (await loadIsomorphicGit());
  const http = input.http ?? (await loadDefaultHttp());

  // Drop resolution-only fields before delegating so cloneWith
  // sees a clean GitCloneOptions + injected deps.
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

async function resolveFs(input: CloneInput): Promise<IsomorphicGitFSClient> {
  if (input.fs) return input.fs;
  if (input.workspace) {
    const provider = input.workspace.provider();
    const adapter = input.adapter ?? workspaceIsomorphicGitClient;
    return await adapter(provider);
  }
  throw new Error(
    "clone() requires either `fs` (a pre-built FsClient) or `workspace` (a handle with .provider()).",
  );
}

async function loadIsomorphicGit(): Promise<IsomorphicGitClient> {
  try {
    const mod = (await import("isomorphic-git")) as unknown as {
      default?: IsomorphicGitClient;
    } & IsomorphicGitClient;
    // isomorphic-git ships both named and default exports
    // depending on the consumer's module resolution. Prefer
    // named, fall back to default.
    if (typeof mod.clone === "function") return mod;
    if (mod.default && typeof mod.default.clone === "function") return mod.default;
    throw new Error("isomorphic-git module did not expose clone()");
  } catch (cause) {
    throw new Error(
      "@cloudflare/workspace/git requires isomorphic-git as an optional peer dependency. " +
        "Install isomorphic-git, or pass `git` to clone() explicitly.",
      { cause: cause as Error },
    );
  }
}

async function loadDefaultHttp(): Promise<object> {
  try {
    const mod = (await import("isomorphic-git/http/web")) as { default: object };
    return mod.default;
  } catch (cause) {
    throw new Error(
      "Failed to load isomorphic-git/http/web. Install isomorphic-git, " +
        "or pass `http` to clone() explicitly.",
      { cause: cause as Error },
    );
  }
}
