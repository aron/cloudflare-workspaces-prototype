/**
 * Helpers for the GitHub→Artifacts→isomorphic-git pipeline.
 *
 * The big picture for a `GitHubRepo` mount:
 *
 *   1. `ensureBaselineRepo()`   imports the GitHub repo into a baseline
 *                               Artifacts repo (shared across sessions
 *                               for the same `(owner, repo, ref)`).
 *                               Idempotent: returns an existing repo on
 *                               409 / "already exists".
 *   2. `cloneIntoVfs()`         runs `isomorphic-git.clone` against the
 *                               baseline remote, writing every blob and
 *                               the .git/ directory through a Vfs-backed
 *                               fs adapter. Bounded by `maxBytes` to
 *                               prevent OOM.
 *
 * Push semantics are deliberately out-of-scope for v1: writes land in the
 * VFS only. Once we add commit/push, this is also where session-scoped
 * forks (`repo.fork(...)`) will live.
 *
 * This module is the single seam where the in-isolate clone happens. The
 * day we move clone work into a Dynamic Worker isolate, only this file
 * changes — neither the mount nor the `gitClone` tool know the difference.
 */

import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import type { Vfs } from "../vfs.js";
import { createVfsFs } from "./vfs-fs.js";

/**
 * Minimal shape of the Artifacts Workers binding that we depend on.
 * Declared locally so this package doesn't take a hard runtime dependency
 * on `@cloudflare/workers-types` augmenting the global namespace.
 */
export interface ArtifactsBinding {
  create(name: string, opts?: ArtifactsCreateOptions): Promise<ArtifactsCreateResult>;
  get(name: string): Promise<ArtifactsRepoHandle>;
  list(opts?: { limit?: number; cursor?: string }): Promise<{ repos: Array<{ name: string; status: string }>; cursor?: string }>;
  import(params: ArtifactsImportParams): Promise<ArtifactsCreateResult>;
  delete(name: string): Promise<boolean>;
}

export interface ArtifactsCreateOptions {
  description?: string;
  readOnly?: boolean;
  setDefaultBranch?: string;
}

export interface ArtifactsCreateResult {
  name: string;
  remote: string;
  defaultBranch: string;
  /** Encoded as `art_v1_<hex>?expires=<unix_seconds>` per the docs. */
  token: string;
}

export interface ArtifactsImportParams {
  source: { url: string; branch?: string; depth?: number };
  target: { name: string; opts?: ArtifactsCreateOptions };
}

export interface ArtifactsRepoHandle {
  remote: string;
  defaultBranch: string;
  createToken(scope?: "read" | "write", ttlSeconds?: number): Promise<{ plaintext: string; expiresAt: string }>;
  fork(name: string, opts?: ArtifactsCreateOptions & { defaultBranchOnly?: boolean }): Promise<ArtifactsCreateResult>;
}

/** GitHub Artifact token format: strip everything from `?expires=` onward. */
export function tokenSecret(token: string): string {
  const idx = token.indexOf("?expires=");
  return idx === -1 ? token : token.slice(0, idx);
}

/** Make a string safe to use as part of an Artifacts repo name. */
export function sanitizeForRepoName(s: string): string {
  // Repo names: start with a letter or digit, then letters/digits/./_/-.
  // We replace anything else with "-", collapse runs, and trim.
  let out = s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  if (!out || !/^[A-Za-z0-9]/.test(out)) out = "x" + out;
  return out.toLowerCase();
}

/**
 * Deterministic baseline name for `(owner, repo, ref)`. Sharing the
 * baseline across sessions amortizes import time.
 */
export function baselineName(owner: string, repo: string, ref: string): string {
  return sanitizeForRepoName(`gh-${owner}-${repo}-${ref}`);
}

export interface EnsureBaselineOptions {
  artifacts: ArtifactsBinding;
  owner: string;
  repo: string;
  ref: string;
  depth?: number;
}

/**
 * Import `https://github.com/<owner>/<repo>` into a baseline Artifacts
 * repo (named deterministically from `(owner, repo, ref)`) if it doesn't
 * already exist. Returns a handle, a read token, and the remote URL.
 *
 * Concurrency: callers within the same DO isolate share the same in-flight
 * promise via the supplied `inflight` cache. Callers across isolates may
 * race; if both win the import call, the second sees a 409-style error
 * and re-fetches via `get()`.
 */
export async function ensureBaselineRepo(opts: EnsureBaselineOptions): Promise<{
  name: string;
  remote: string;
  token: string;
  defaultBranch: string;
}> {
  const name = baselineName(opts.owner, opts.repo, opts.ref);
  const url  = `https://github.com/${opts.owner}/${opts.repo}`;

  // Fast path: repo already exists. Properties on the RPC stub are
  // JsRpcProperty thenables — await them, otherwise we'd stringify a
  // "[object JsRpcProperty]" into the remote URL and isomorphic-git
  // would reject it on parse.
  try {
    const handle = await opts.artifacts.get(name);
    const tk = await handle.createToken("read", 3600);
    const [remote, defaultBranch] = await Promise.all([
      handle.remote,
      handle.defaultBranch,
    ]);
    return {
      name,
      remote,
      token: tk.plaintext,
      defaultBranch,
    };
  } catch {
    // Fall through to import.
  }

  try {
    const created = await opts.artifacts.import({
      source: { url, branch: opts.ref, depth: opts.depth ?? 1 },
      target: { name, opts: { description: `Imported from ${url}@${opts.ref}`, readOnly: true } },
    });
    // Same JsRpcProperty hazard as the fast-path — await each property
    // so we never stringify a thenable into the remote URL.
    const [createdName, remote, token, defaultBranch] = await Promise.all([
      created.name,
      created.remote,
      created.token,
      created.defaultBranch,
    ]);
    return {
      name:  createdName,
      remote,
      token,
      defaultBranch,
    };
  } catch (err) {
    // Two writers raced; the loser re-reads via get(). Log the original
    // error so it's not silently swallowed in dev.
    console.warn(`[GitHubRepo] import race for ${name}, falling back to get():`, err);
    const handle = await opts.artifacts.get(name);
    const tk = await handle.createToken("read", 3600);
    const [remote, defaultBranch] = await Promise.all([
      handle.remote,
      handle.defaultBranch,
    ]);
    return {
      name,
      remote,
      token: tk.plaintext,
      defaultBranch,
    };
  }
}

export interface CloneOptions {
  vfs: Vfs;
  /** Absolute path inside the VFS that becomes the working tree root. */
  dir: string;
  /** Artifacts remote URL (`https://<account>.artifacts.cloudflare.net/git/...`). */
  remote: string;
  /** Read token from `createToken` / import / fork. */
  token: string;
  ref?: string;
  depth?: number;
  /** Hard byte budget across all writes; throws `EFBIG` once exceeded. */
  maxBytes?: number;
  /** Single-branch shallow by default. */
  singleBranch?: boolean;
  /** Author identity used for any later commits (no effect on clone itself). */
  author?: { name: string; email: string };
}

/**
 * Clone the Artifacts remote into the VFS at `dir`. After this returns,
 * the working tree (including `.git/`) is materialized under `dir` and
 * can be read like any other VFS subtree.
 *
 * Throws if `maxBytes` is exceeded mid-clone — callers should treat that
 * as a hard failure and tear down the partial state under `dir`.
 */
export async function cloneIntoVfs(opts: CloneOptions): Promise<{ bytesWritten: number; head?: string }> {
  const fs = createVfsFs(opts.vfs, {
    mountRoot: opts.dir,
    maxBytes:  opts.maxBytes,
  });
  const secret = tokenSecret(opts.token);

  await git.clone({
    fs,
    http,
    dir: opts.dir,
    url: opts.remote,
    ref: opts.ref,
    depth: opts.depth ?? 1,
    singleBranch: opts.singleBranch ?? true,
    onAuth: () => ({ username: "x", password: secret }),
  });

  let head: string | undefined;
  try {
    head = await git.resolveRef({ fs, dir: opts.dir, ref: "HEAD" });
  } catch {
    // No HEAD yet (empty repo) — fine, return undefined.
  }

  return { bytesWritten: fs.bytesWritten(), head };
}
