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
 * Subset of the Cloudflare Artifacts Workers binding we depend on.
 * Declared locally so this package doesn't take a hard runtime dependency
 * on `@cloudflare/workers-types` augmenting the global namespace.
 *
 * Mirrors the shapes published in @cloudflare/workers-types/experimental
 * (`interface Artifacts`, `interface ArtifactsRepo`, etc.).
 */
export interface ArtifactsBinding {
  create(name: string, opts?: ArtifactsCreateOptions): Promise<ArtifactsCreateRepoResult>;
  get(name: string): Promise<ArtifactsRepo>;
  list(opts?: { limit?: number; cursor?: string }): Promise<ArtifactsRepoListResult>;
  import(params: ArtifactsImportParams): Promise<ArtifactsCreateRepoResult>;
  delete(name: string): Promise<boolean>;
}

export interface ArtifactsCreateOptions {
  description?: string;
  readOnly?: boolean;
  setDefaultBranch?: string;
}

/** Returned by `create()` and `import()` — includes a fresh access token. */
export interface ArtifactsCreateRepoResult {
  id: string;
  name: string;
  description: string | null;
  defaultBranch: string;
  remote: string;
  token: string;
  tokenExpiresAt: string;
}

/** Per-repo metadata returned by `get()` and embedded in list/import results. */
export interface ArtifactsRepoInfo {
  id: string;
  name: string;
  description: string | null;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  lastPushAt: string | null;
  source: string | null;
  readOnly: boolean;
  remote: string;
}

export interface ArtifactsRepoListResult {
  repos: Omit<ArtifactsRepoInfo, "remote">[];
  total: number;
  cursor?: string;
}

export interface ArtifactsCreateTokenResult {
  id: string;
  plaintext: string;
  scope: "read" | "write";
  expiresAt: string;
}

export interface ArtifactsImportParams {
  source: { url: string; branch?: string; depth?: number };
  target: { name: string; opts?: { description?: string; readOnly?: boolean } };
}

/** Repo handle returned by `get()` — extends the data with RPC methods. */
export interface ArtifactsRepo extends ArtifactsRepoInfo {
  createToken(scope?: "read" | "write", ttl?: number): Promise<ArtifactsCreateTokenResult>;
  fork(name: string, opts?: ArtifactsCreateOptions & { defaultBranchOnly?: boolean }): Promise<ArtifactsCreateRepoResult>;
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
 * already exist. Returns the remote, a fresh read token, and the default
 * branch.
 *
 * # Why this is more contorted than it ought to be
 *
 * `Artifacts.get(name)` returns an `ArtifactsRepo` which extends `RpcTarget`
 * and exposes `remote` / `defaultBranch` as readonly **fields** (assigned in
 * its constructor). workerd's JsRpcTarget refuses to proxy own-properties
 * over RPC — only class-defined methods and getters on the prototype are
 * accessible. Reading `await handle.remote` therefore fails with
 * `The RPC receiver does not implement the method "remote"`. The TypeScript
 * declarations in @cloudflare/workers-types lie about this working.
 *
 * `Artifacts.import()` / `Artifacts.create()` return plain `CreateRepoResult`
 * objects (not RpcTarget instances), which capnweb serializes by value. So
 * we can read `.remote` and `.token` directly off those returns.
 *
 * Strategy:
 *   1. Try `import()` first. If the repo is new, we get a fresh
 *      `CreateRepoResult` with everything we need in one round trip.
 *   2. If `import()` fails with `ALREADY_EXISTS`, fall back to `list()`,
 *      which returns plain `RemoteRepoInfo[]` (and *does* include `remote`)
 *      and then mint a token via `get().createToken()` — `createToken` is
 *      a class method on the prototype so it survives the RPC boundary.
 *
 * Concurrency: callers across isolates may race on the import; the loser
 * sees `ALREADY_EXISTS` and falls back to the list path, which is
 * eventually consistent.
 */
export async function ensureBaselineRepo(opts: EnsureBaselineOptions): Promise<{
  name: string;
  remote: string;
  token: string;
  defaultBranch: string;
}> {
  const name = baselineName(opts.owner, opts.repo, opts.ref);
  const url  = `https://github.com/${opts.owner}/${opts.repo}`;

  // Primary path: import. Returns plain data with `remote` and `token`
  // accessible as ordinary string properties.
  try {
    const created = await opts.artifacts.import({
      source: { url, branch: opts.ref, depth: opts.depth ?? 1 },
      target: { name, opts: { description: `Imported from ${url}@${opts.ref}`, readOnly: true } },
    });
    return {
      name,
      remote: created.remote,
      token:  created.token,
      defaultBranch: created.defaultBranch,
    };
  } catch (err) {
    // Anything other than "already exists" is fatal — the caller wraps
    // this in an "artifacts import failed" error message anyway.
    if (!isAlreadyExistsError(err)) throw err;
  }

  // Repo already exists. Find its `remote` / `defaultBranch` via list()
  // (plain data, no RPC stub problems) and mint a fresh read token via
  // get().createToken() (method, not field — survives the RPC boundary).
  const remoteInfo = await findRepoByName(opts.artifacts, name);
  if (!remoteInfo) {
    // Tiny race window: import() saw ALREADY_EXISTS but list() can't find
    // it (e.g. it was deleted between the two calls). Surface a clear error.
    throw new Error(`baseline repo "${name}" disappeared after import reported ALREADY_EXISTS`);
  }
  const handle = await opts.artifacts.get(name);
  const tk = await handle.createToken("read", 3600);
  return {
    name,
    remote: remoteInfo.remote,
    token:  tk.plaintext,
    defaultBranch: remoteInfo.defaultBranch,
  };
}

/** Walks list() pages until we find the baseline, or exhaust the namespace. */
async function findRepoByName(
  artifacts: ArtifactsBinding,
  name: string,
): Promise<ArtifactsRepoInfo | null> {
  let cursor: string | undefined;
  do {
    const page = await artifacts.list({ limit: 200, cursor });
    for (const repo of page.repos) {
      if (repo.name === name) {
        // list() returns repos *without* the `remote` field per the types,
        // but we need it. Cast via a follow-up that has it. In practice
        // the live binding includes `remote` on list entries too — if it
        // doesn't, we'd surface a clear error below.
        const withRemote = repo as ArtifactsRepoInfo & { remote?: string };
        if (!withRemote.remote) {
          throw new Error(`list() returned repo "${name}" without a remote URL`);
        }
        return withRemote as ArtifactsRepoInfo;
      }
    }
    cursor = page.cursor;
  } while (cursor);
  return null;
}

/** Best-effort match against the documented `ALREADY_EXISTS` error code. */
function isAlreadyExistsError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && code === "ALREADY_EXISTS") return true;
  const message = (err as { message?: unknown }).message;
  return typeof message === "string" && /already.*exists/i.test(message);
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
