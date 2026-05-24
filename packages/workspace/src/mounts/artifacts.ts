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

// ---- session-fork + push + share-URL helpers ----
//
// Used by the commit/push/share tools to:
//   1. fork the baseline into a stable per-session repo on first push
//   2. push the local wip branch to that fork
//   3. mint a short-lived read-only URL the user can `git remote add`
//
// State lives in a caller-supplied `ForkRegistry` (typically backed by
// DO SQL) keyed on the working-tree dir. The artifacts module is
// stateless — it never owns the registry, just calls into it.

/** One row in the fork registry, keyed on the working-tree dir. */
export interface ForkRecord {
  /** Working-tree path inside the VFS. */
  dir: string;
  /** Baseline (shared) Artifacts repo name we forked from. */
  baselineName: string;
  /** Per-session fork repo name. */
  forkName: string;
  /** Full Artifacts remote URL for the fork. */
  forkRemote: string;
  /** Default branch on the fork. */
  defaultBranch: string;
  /** Internal write token (full `art_v1_...?expires=...` form). */
  writeToken: string;
  /** Unix seconds at which `writeToken` stops working. */
  writeTokenExpiresAt: number;
}

/**
 * Tiny storage interface for fork metadata. Implementations typically
 * wrap a SQL table on the agent's DO.
 */
export interface ForkRegistry {
  get(dir: string): ForkRecord | null;
  upsert(record: ForkRecord): void;
  delete(dir: string): void;
}

/**
 * Per-session fork name. Stable for the lifetime of `sessionId` against
 * a given `(owner, repo)` — multiple `gitShare` calls from the same
 * session reuse the same fork.
 */
export function sessionForkName(owner: string, repo: string, sessionId: string): string {
  return sanitizeForRepoName(`gh-${owner}-${repo}-session-${sessionId}`);
}

/**
 * Default wip branch for a session. One branch per session by design —
 * sharing a second working tree from the same session would clobber.
 * Callers that want per-dest branches can pass an explicit `branch` to
 * the tools.
 */
export function sessionWipBranch(sessionId: string): string {
  // Branch names allow slashes; we just sanitize the session id segment.
  return `wip/agent-${sanitizeForRepoName(sessionId)}`;
}

/**
 * Parse `forkName` out of an Artifacts remote URL. Tolerates trailing
 * `.git` and assumes the namespace-then-name layout the docs describe.
 */
export function parseRemoteForkName(remote: string): { namespace: string; name: string } {
  // Expected shape:
  // https://<account>.artifacts.cloudflare.net/git/<namespace>/<name>.git
  const u = new URL(remote);
  const parts = u.pathname.replace(/^\/git\//, "").replace(/\.git$/, "").split("/");
  if (parts.length !== 2) throw new Error(`unrecognized Artifacts remote: ${remote}`);
  return { namespace: parts[0], name: parts[1] };
}

export interface EnsureSessionForkOptions {
  artifacts: ArtifactsBinding;
  baselineName: string;
  owner: string;
  repo: string;
  sessionId: string;
  registry: ForkRegistry;
  dir: string;
  /** Write-token TTL in seconds. Default 24h. */
  writeTokenTtl?: number;
}

/**
 * Idempotent. On first call per `(sessionId, dir)`:
 *   - forks the baseline into a per-session repo
 *   - stores the fork remote + write token in the registry
 * On subsequent calls, returns the cached record — minting a fresh
 * write token if the cached one has expired.
 */
export async function ensureSessionFork(opts: EnsureSessionForkOptions): Promise<ForkRecord> {
  const ttl = opts.writeTokenTtl ?? 86_400;
  const cached = opts.registry.get(opts.dir);
  const nowSec = Math.floor(Date.now() / 1000);

  // Reuse the cached fork if present and the write token hasn't expired.
  if (cached && cached.writeTokenExpiresAt - nowSec > 60) {
    return cached;
  }

  const forkName = cached?.forkName ?? sessionForkName(opts.owner, opts.repo, opts.sessionId);

  // Create-or-get the fork. If we have a cached record, the fork already
  // exists; we just need a fresh write token via createToken().
  let forkRemote: string;
  let defaultBranch: string;
  let writeToken: string;

  if (cached) {
    const handle = await opts.artifacts.get(forkName);
    forkRemote = handle.remote;
    defaultBranch = handle.defaultBranch;
    const tk = await handle.createToken("write", ttl);
    writeToken = tk.plaintext;
  } else {
    const baseline = await opts.artifacts.get(opts.baselineName);
    try {
      const forked = await baseline.fork(forkName, {
        description: `Session fork for ${opts.sessionId} from ${opts.baselineName}`,
        readOnly: false,
      });
      forkRemote = forked.remote;
      defaultBranch = forked.defaultBranch;
      writeToken = forked.token;
    } catch (err) {
      // The fork may already exist (a prior DO incarnation forked but
      // never persisted the registry row). Recover via get().
      console.warn(`[gitShare] fork ${forkName} create failed, falling back to get():`, err);
      const handle = await opts.artifacts.get(forkName);
      forkRemote = handle.remote;
      defaultBranch = handle.defaultBranch;
      const tk = await handle.createToken("write", ttl);
      writeToken = tk.plaintext;
    }
  }

  const record: ForkRecord = {
    dir: opts.dir,
    baselineName: opts.baselineName,
    forkName,
    forkRemote,
    defaultBranch,
    writeToken,
    writeTokenExpiresAt: nowSec + ttl,
  };
  opts.registry.upsert(record);
  return record;
}

export interface PushOptions {
  vfs: Vfs;
  /** Working-tree path inside the VFS. */
  dir: string;
  /** Remote URL we're pushing to (typically the fork's `forkRemote`). */
  remote: string;
  /** Write token (`art_v1_...?expires=...` form). */
  writeToken: string;
  /** Local ref to push. Default "HEAD". */
  ref?: string;
  /** Remote ref to push to. Required — typically the wip branch. */
  remoteRef: string;
  /** Default true. wip branches are agent-owned. */
  force?: boolean;
}

/**
 * Push `ref` (default HEAD) to `remote` `remoteRef`. Uses isomorphic-git
 * directly against the supplied URL — the working tree's `.git/config`
 * origin (which points at the baseline) is left alone.
 */
export async function pushToRemote(opts: PushOptions): Promise<{ ok: boolean; refs: unknown }> {
  const fs = createVfsFs(opts.vfs, { mountRoot: opts.dir });
  const secret = tokenSecret(opts.writeToken);
  const result = await git.push({
    fs,
    http,
    dir: opts.dir,
    url: opts.remote,
    ref: opts.ref ?? "HEAD",
    remoteRef: opts.remoteRef,
    force: opts.force ?? true,
    onAuth: () => ({ username: "x", password: secret }),
  });
  return { ok: !!result.ok, refs: result.refs };
}

export interface MintShareUrlOptions {
  artifacts: ArtifactsBinding;
  forkName: string;
  /** Token TTL in seconds. Default 3600 (1 hour). */
  ttlSeconds?: number;
  /**
   * Token scope. `"read"` (default) mints a fetch-only URL the user can
   * `git remote add` for code review; `"write"` mints a URL they can also
   * push back through so the agent picks up their changes.
   */
  scope?: "read" | "write";
}

/**
 * Mint a fresh token on `forkName` and return an HTTPS URL with the
 * secret embedded in Basic auth. Suitable for handing to a user who
 * will `git remote add` against it.
 *
 * Defaults to a read-only token (TTL 1 hour). Pass `scope: "write"` to
 * mint a URL that also accepts `git push`. Artifacts caps tokens at
 * min 60s / max 1 year.
 */
export async function mintShareUrl(opts: MintShareUrlOptions): Promise<{ url: string; expiresAt: string; remote: string; scope: "read" | "write" }> {
  const ttl   = opts.ttlSeconds ?? 3600;
  const scope = opts.scope ?? "read";

  // Resolve `remote` via list() rather than reading `handle.remote` off the
  // get() stub. ArtifactsRepo exposes `remote` as an own-property field, and
  // workerd's JsRpcTarget refuses to proxy own-properties over RPC — reading
  // it back raises 'The RPC receiver does not implement the method "remote"',
  // which previously surfaced as `new URL(undefined)` → 'Invalid URL string'.
  // `list()` returns plain-data RepoInfo entries that *do* carry remote.
  const info = await findRepoByName(opts.artifacts, opts.forkName);
  if (!info) {
    throw new Error(`mintShareUrl: fork "${opts.forkName}" not found`);
  }
  const remote = info.remote;

  // createToken is a prototype method, so calling it on the get() handle is
  // fine — the own-property restriction only bites for fields.
  const handle = await opts.artifacts.get(opts.forkName);
  const tk = await handle.createToken(scope, ttl);
  const secret = tokenSecret(tk.plaintext);

  // Convert https://host/... → https://x:<secret>@host/...
  const u = new URL(remote);
  u.username = "x";
  u.password = secret;
  return { url: u.toString(), expiresAt: tk.expiresAt, remote, scope };
}

export interface CommitChangesOptions {
  vfs: Vfs;
  /** Working-tree path inside the VFS. */
  dir: string;
  message: string;
  author: { name: string; email: string };
}

/**
 * Stage every change in the working tree (additions, modifications,
 * deletions) and produce one commit. Honours `.gitignore` via
 * `statusMatrix`'s built-in ignore handling.
 *
 * Returns the new HEAD sha, or `null` if there was nothing to commit.
 */
export async function commitWorkingTree(opts: CommitChangesOptions): Promise<{ head: string; added: number; modified: number; removed: number } | null> {
  const fs = createVfsFs(opts.vfs, { mountRoot: opts.dir });
  const matrix = await git.statusMatrix({ fs, dir: opts.dir });

  let added = 0;
  let modified = 0;
  let removed = 0;

  for (const [filepath, headStatus, workdirStatus, _stageStatus] of matrix) {
    if (workdirStatus === headStatus) continue;          // unchanged
    if (workdirStatus === 0) {
      await git.remove({ fs, dir: opts.dir, filepath });
      removed++;
    } else {
      await git.add({ fs, dir: opts.dir, filepath });
      if (headStatus === 0) added++; else modified++;
    }
  }

  if (added === 0 && modified === 0 && removed === 0) {
    return null;
  }

  const head = await git.commit({
    fs,
    dir: opts.dir,
    message: opts.message,
    author: opts.author,
  });
  return { head, added, modified, removed };
}
