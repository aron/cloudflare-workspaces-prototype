/**
 * Workspace — Durable-Object-side facade combining:
 *   - a SQLite-backed VFS (Vfs)
 *   - incremental sync to a `@cloudflare/sandbox` container running the
 *     companion `container-sandbox` server
 *   - direct file ops that round-trip nothing through the container
 *
 * Construction is cheap: nothing networks until you call `exec()` or
 * `warmup()`. Sync watermarks (pushSeq / pullSinceRev) are persisted to the
 * DO storage so reconnects/restarts resume cleanly.
 */

import { getSandbox, parseSSEStream, type LogEvent, type Process, type Sandbox } from "@cloudflare/sandbox";

import { Vfs } from "./vfs.js";
import { ContainerConnection } from "./container-connection.js";
import { ensureWorkspaceServer } from "./container-startup.js";
import type { Mount, MountInput, MountContext, MountWriteApi } from "./mounts/index.js";
import { asFactory } from "./mounts/index.js";
import { pathStartsWith, type ContainerRpc, type ExecResult, type GrepHit, type FileStat, type VfsChange } from "./shared/index.js";
import { createQueue, serialize, type Queue } from "./serialize.js";
import { parseWorkspacePath } from "./path.js";
import { chunkHashUnion, assembleFileBytes, hashKey } from "./pull-assembly.js";

export interface WorkspaceOptions {
  /** DO storage to mount the VFS on. */
  storage: DurableObjectStorage;
  /** The @cloudflare/sandbox Durable Object namespace binding. */
  sandbox: DurableObjectNamespace<Sandbox>;
  /** Caller-side identifier (e.g. an agent's DO `name`). */
  sessionId: string;
  /** Container port the workspace server listens on. Defaults to 4567. */
  port?: number;
  /**
   * Optional: resolve the caller's `sessionId` into the name passed to
   * `getSandbox(sandbox, name)`. Use this to route through a warm pool.
   * Called once on first use, cached for the lifetime of the Workspace.
   * Defaults to identity (sessionId itself names the Sandbox DO).
   */
  resolveSessionId?: (sessionId: string) => Promise<string> | string;
  /**
   * Read-only mounts keyed by absolute VFS path (the mount root).
   * Index (directory tree + file metadata) is fetched lazily on first use;
   * file content is fetched per-file the first time something reads it.
   * Writes anywhere under a mount root throw EROFS.
   */
  mounts?: Record<string, MountInput>;
  /**
   * Path segments excluded from the post-`exec()` pull. Default:
   * `['node_modules']`. Matched against any path that contains
   * `/<segment>/` or ends with `/<segment>`. Excluded paths never
   * cross the wire from the container to the DO, so the bytes stay
   * in the (ephemeral) container only. Anything that *uses* the
   * excluded files (`exec("node ...")`, `runWasm`, etc.) still works
   * because the bytes are already on the container side.
   *
   * Pass `[]` to disable the default and pull everything.
   */
  pullIgnore?: string[];
}

const WATERMARK_TABLE = `
CREATE TABLE IF NOT EXISTS _workspace_watermark (
  k TEXT PRIMARY KEY,
  v INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS _workspace_mounts (
  root     TEXT PRIMARY KEY,
  kind     TEXT NOT NULL,
  indexed  INTEGER NOT NULL DEFAULT 0
);
`;

/**
 * One change to apply to the DO-side VFS during a pull. Produced by
 * `_pullDirtyV2` (manifest path) or `_pullDirtyLegacy` (bytes path) and
 * consumed by `vfs.applyChangesSync` and the writable-mount mirror loop.
 */
type ApplyEntry = {
  path:  string;
  op:    "upsert" | "delete";
  type?: "file" | "dir";
  mode?: number;
  mtime?: number;
  bytes?: Uint8Array;
};
type MirrorEntry = ApplyEntry & { root: string; mount: Mount; relPath: string };

/**
 * True if `err` is the capnweb-side error raised when the container's
 * `ContainerRpc` doesn't expose `method`. capnweb's read loop throws a
 * plain `TypeError` with the message `'<method>' is not a function.` when
 * the peer's bootstrap stub lacks the call, so we match by both the
 * TypeError shape and the literal method name. Anything else (real RPC
 * errors, transport failures, etc.) still propagates.
 */
export function isMissingRpcMethod(err: unknown, method: string): boolean {
  return err instanceof TypeError && err.message.includes(`'${method}' is not a function`);
}

export class Workspace {
  readonly vfs: Vfs;
  private opts: WorkspaceOptions & { port: number };
  private sql: SqlStorage;
  /** Cached result of resolveSessionId(opts.sessionId). null until first lookup. */
  private resolvedSandboxName: string | null = null;

  // Sync watermarks (persisted in _workspace_watermark)
  private pushSeq      = 0;  // last VFS `seq` pushed to the container
  // Last container-side monotonic revision seen on pull .
  // Replaces the old wall-clock mtime watermark, which lost same-millisecond
  // writes once it advanced past them.
  private pullSinceRev = 0;

  // ---- mounts ----
  /** Normalized mount roots (no trailing slash), sorted longest-first for prefix matching. */
  private mountRoots: string[] = [];
  /** Per-mount index state. Once indexed, stays indexed for the DO lifetime. */
  private mountIndexed = new Map<string, boolean>();
  private indexingPromise: Promise<void> | null = null;
  /** Per-file in-flight fetches — dedupes concurrent reads of the same stub. */
  private contentFetches = new Map<string, Promise<void>>();
  /** Bounded concurrency for batch hydration during exec(). */
  private static readonly FETCH_CONCURRENCY = 8;

  // ---- container connection ----
  /** Cached connection to the container's workspace-server. Rebuilt lazily after close. */
  private conn: ContainerConnection | null = null;
  /** Memoised in-flight ensureContainerProcess promise; clears on rejection so callers can retry. */
  private ensurePromise: Promise<void> | null = null;

  // ---- per-workspace mutex ----
  /**
   * FIFO queue serializing all mutating + sync entry points (exec,
   * writeFile, mkdir, deleteFile).  Without this, concurrent calls
   * could read overlapping watermarks, interleave mount-side writes,
   * and race the Vfs.applying flag through async gaps.  Pure reads
   * (readFile, readdir, stat, findFiles, grep, listFilesUnder) stay
   * outside the queue — readers shouldn't wait on writers.
   */
  private mutex: Queue = createQueue();

  constructor(opts: WorkspaceOptions) {
    this.opts = { port: 4567, ...opts };
    this.sql = (opts.storage as DurableObjectStorage & { sql: SqlStorage }).sql;
    this.vfs = new Vfs(this.sql);
    this.sql.exec(WATERMARK_TABLE);
    for (const r of this.sql.exec(`SELECT k, v FROM _workspace_watermark`) as Iterable<{ k: string; v: number }>) {
      if (r.k === "pushSeq")      this.pushSeq      = r.v;
      // Stage-1 migration: read the new key if present,
      // and tolerate the legacy `pullSinceMs` row by leaving the rev
      // watermark at 0 (the next pull re-fetches everything from
      // rev 0 — a one-time cost on the first boot post-upgrade).
      if (r.k === "pullSinceRev") this.pullSinceRev = r.v;
    }

    // Normalize and reconcile configured mounts against the persisted state.
    // Anything in the table that no longer matches the configured mount kind
    // (or is no longer configured at all) gets its subtree wiped — we'll
    // re-index on demand.
    // Realize every factory once, with the session context, so the rest of
    // the constructor (and the reconcile loop below) sees concrete Mounts.
    // Factories are cheap — they just close over options; expensive work
    // (list, fork, clone) is deferred to ensureMountsIndexed().
    const configured = new Map<string, Mount>();
    for (const [rawRoot, input] of Object.entries(opts.mounts ?? {})) {
      const root = normalizeMountRoot(rawRoot);
      if (configured.has(root)) throw new Error(`duplicate mount root: ${root}`);
      const ctx: MountContext = { sessionId: opts.sessionId, root, vfs: this.vfs };
      configured.set(root, asFactory(input)(ctx));
    }
    // Reject overlapping mounts (one root being a prefix of another).
    const roots = [...configured.keys()];
    for (const a of roots) for (const b of roots) {
      if (a !== b && (b + "/").startsWith(a + "/")) {
        throw new Error(`mount root ${a} overlaps with ${b}`);
      }
    }
    this.mountRoots = roots.sort((a, b) => b.length - a.length);

    const persisted = [...this.sql.exec<{ root: string; kind: string; indexed: number }>(
      `SELECT root, kind, indexed FROM _workspace_mounts`,
    )];
    for (const row of persisted) {
      const m = configured.get(row.root);
      if (!m || m.kind !== row.kind) {
        // Configuration changed: purge stale subtree + row.
        this.vfs.deleteFile(row.root);
        this.sql.exec(`DELETE FROM _workspace_mounts WHERE root = ?`, row.root);
      } else {
        this.mountIndexed.set(row.root, row.indexed === 1);
      }
    }
    for (const root of roots) {
      if (!this.mountIndexed.has(root)) {
        this.sql.exec(
          `INSERT OR IGNORE INTO _workspace_mounts(root, kind, indexed) VALUES (?, ?, 0)`,
          root, configured.get(root)!.kind,
        );
        this.mountIndexed.set(root, false);
      }
    }
    this.configuredMounts = configured;
  }

  private configuredMounts: Map<string, Mount> = new Map();

  /** Resolve and cache the sandbox DO name (UUID when using a warm pool). */
  private async sandboxName(): Promise<string> {
    if (this.resolvedSandboxName !== null) return this.resolvedSandboxName;
    const resolve = this.opts.resolveSessionId;
    this.resolvedSandboxName = resolve ? await resolve(this.opts.sessionId) : this.opts.sessionId;
    return this.resolvedSandboxName;
  }

  // ---- direct VFS (no container round-trip) ----
  //
  // All read/write methods are async: they may need to index a mount
  // (one R2 list() call) or hydrate file content (one R2 get() call) on
  // first use. After the index is built and content is cached, subsequent
  // calls degrade to a couple of SQL statements — cheap, but still async
  // for API consistency.

  async readFile(path: string): Promise<Uint8Array | null> {
    const cp = parseWorkspacePath(path);
    await this.ensureMountsIndexed();
    await this.ensureContentLoaded(cp);
    return this.vfs.readFile(cp);
  }

  async writeFile(path: string, content: Uint8Array | string, mode?: number): Promise<void> {
    const cp = parseWorkspacePath(path);
    await this.ensureMountsIndexed();
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
    return serialize(this.mutex, async () => {
      // Preserve the existing file's mode on overwrite when the caller didn't
      // specify one — otherwise a plain `writeFile(path, bytes)` would silently
      // downgrade an executable script (0o100755) to a regular file (0o100644).
      // Callers that *want* to change the mode pass it explicitly.
      const effectiveMode = mode ?? this.vfs.stat(cp)?.mode ?? 0o100644;
      const m = this.resolveMountForWrite(cp);
      if (m) {
        // Push to the backing store first — if it fails, the VFS stays clean.
        await m.mount.put!(m.relPath, bytes);
        this.vfs.writeFile(cp, bytes, effectiveMode, m.root);
      } else {
        this.vfs.writeFile(cp, bytes, effectiveMode);
      }
    });
  }

  async readdir(path: string): Promise<Array<{ name: string; type: "file" | "dir" }>> {
    const cp = parseWorkspacePath(path);
    await this.ensureMountsIndexed();
    return this.vfs.readdir(cp);
  }

  async stat(path: string): Promise<FileStat | null> {
    const cp = parseWorkspacePath(path);
    await this.ensureMountsIndexed();
    return this.vfs.stat(cp);
  }

  async mkdir(path: string, mode?: number): Promise<void> {
    const cp = parseWorkspacePath(path);
    await this.ensureMountsIndexed();
    return serialize(this.mutex, async () => {
      // mkdir is VFS-only even under writable mounts: R2 has no directories,
      // and synthesizing zero-byte directory markers would surface as files.
      const m = this.resolveMountForWrite(cp);
      this.vfs.mkdir(cp, mode, m ? m.root : null);
    });
  }

  async deleteFile(path: string): Promise<void> {
    const cp = parseWorkspacePath(path);
    await this.ensureMountsIndexed();
    return serialize(this.mutex, async () => {
      const m = this.resolveMountForWrite(cp);
      if (m) {
        // Collect every file under `path` (could be a single file or a subtree)
        // and delete each from the backing store before touching the VFS.
        const subtree = this.vfs.listFilesUnder(cp);
        const files   = subtree.length ? subtree : (this.vfs.stat(cp)?.type === "file" ? [cp] : []);
        const rels    = files.map(f => f.slice(m.root.length + 1));
        await this.runBounded(rels, r => m.mount.delete!(r));
      }
      this.vfs.deleteFile(cp);
    });
  }

  async listFilesUnder(prefix: string): Promise<string[]> {
    const cp = parseWorkspacePath(prefix);
    await this.ensureMountsIndexed();
    return this.vfs.listFilesUnder(cp);
  }

  /** Search filenames under `directory` for `pattern` (substring match). */
  /** Search filenames under `directory` for `pattern` (substring match). */
  async findFiles(directory: string, pattern?: string): Promise<Array<{ path: string; type: "file" | "dir" }>> {
    const cp = parseWorkspacePath(directory);
    await this.ensureMountsIndexed();
    return this.vfs.snapshot().entries
      .filter(e => pathStartsWith(e.path, cp))
      .filter(e => !pattern || e.path.includes(pattern))
      .map(e => ({ path: e.path, type: e.type }));
  }

  /** Grep file contents for `pattern`. `path` may be a file or directory. */
  async grep(pattern: string, path: string, opts: { ignoreCase?: boolean } = {}): Promise<GrepHit[]> {
    const cp = parseWorkspacePath(path);
    await this.ensureMountsIndexed();
    const needle = opts.ignoreCase ? pattern.toLowerCase() : pattern;
    const { entries } = this.vfs.snapshot();
    const files = entries.filter(e => e.type === "file" && pathStartsWith(e.path, cp));
    // Hydrate any mount stubs in scope, bounded-concurrent.
    await this.hydrateMany(files.map(f => f.path));
    const hits: GrepHit[] = [];
    for (const f of files) {
      const bytes = this.vfs.readFile(f.path);
      if (!bytes) continue;
      const text = new TextDecoder().decode(bytes);
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const hay = opts.ignoreCase ? lines[i].toLowerCase() : lines[i];
        if (hay.includes(needle)) hits.push({ path: f.path, line: i + 1, text: lines[i] });
      }
    }
    return hits;
  }

  // ---- container exec with bidirectional sync ----

  /**
   * Run `command` inside the sandbox container after pushing any DO-side
   * changes; pull files the command produced back into the VFS afterwards.
   *
   * cwd defaults to `/tmp` to avoid a FUSE getattr round-trip during spawn
   * (spawning into the FUSE mount can deadlock when the server is under
   * load right after an applyChanges flush). Use absolute paths in `command`.
   */
  async exec(command: string, cwd?: string): Promise<ExecResult> {
    await this.ensureMountsIndexed();
    return serialize(this.mutex, async () => {
    const sb = getSandbox(this.opts.sandbox, await this.sandboxName());
    const api = await this.getConnection();

    // Hydrate any mount stubs we're about to push — otherwise the container
    // would receive empty files. We pre-fetch in bounded parallel before
    // computing the change set so the freshly-written rows are included.
    const stubs = this.vfs.listStubs().map(s => s.path);
    if (stubs.length) await this.hydrateMany(stubs);

    // Push the delta since the last exec.
    const changes = this.vfs.getChangesSince(this.pushSeq);
    if (changes.length) {
      await api.applyChanges(changes);
      this.pushSeq = changes[changes.length - 1].seq;
    }

    const result = await sb.exec(command, { cwd: cwd ?? "/tmp" });

    const pulled = await this._pullDirtyAfterLocked();


    return {
      exitCode: result.exitCode,
      stdout:   result.stdout,
      stderr:   result.stderr,
      pushed:   changes.length,
      pulled,
    };
    });
  }

  /**
   * Pre-warm the container without running a command. Idempotent.
   * Use from `onStart()` in `ctx.waitUntil(...)` so the first exec is fast.
   */
  async warmup(): Promise<void> {
    await this.ensureMountsIndexed();
    await this.ensureContainerProcess();
  }

  /**
   * Start a long-running process in the sandbox container, returning a
   * `Process` handle the caller can stream logs from, await exit on, or
   * kill. Performs the same DO→container push as `exec` so the process
   * sees the latest VFS state.
   *
   * Caller is responsible for pulling DO←container deltas after the
   * process exits via `pullDirtyAfter(...)` — we can't bake that into
   * the returned handle because the consumer typically wants to stream
   * logs in parallel with the wait.
   */
  async startProcess(
    command: string,
    opts: { cwd?: string } = {},
  ): Promise<Process> {
    await this.ensureMountsIndexed();
    return serialize(this.mutex, async () => {
      const sb = getSandbox(this.opts.sandbox, await this.sandboxName());
      const api = await this.getConnection();

      // Same pre-flight as exec: hydrate stub mounts then push the delta.
      const stubs = this.vfs.listStubs().map(s => s.path);
      if (stubs.length) await this.hydrateMany(stubs);
      const changes = this.vfs.getChangesSince(this.pushSeq);
      if (changes.length) {
        await api.applyChanges(changes);
        this.pushSeq = changes[changes.length - 1].seq;
      }

      return sb.startProcess(command, { cwd: opts.cwd ?? "/tmp" });
    });
  }

  /**
   * Stream `LogEvent`s from a running (or recently-running) process.
   * Decodes the sandbox SDK's SSE wire format so callers iterate
   * structured events directly.
   *
   * Cancellation: pass an `AbortSignal` and we translate `abort` into a
   * `killProcess(processId)` call worker-side. We do *not* forward the
   * signal to `sb.streamProcessLogs` itself:
   *   - workerd refuses to serialize an `AbortSignal` across the DO RPC
   *     boundary ("AbortSignal serialization is not enabled").
   *   - the sandbox SDK's HTTP transport drops the option two layers
   *     down anyway (process-client's `streamProcessLogs` doesn't even
   *     accept it).
   * Killing the process stops the sandbox emitting log events; the SSE
   * stream then closes naturally and the consuming iterator returns.
   */
  async streamProcessLogs(
    processId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<AsyncIterable<LogEvent>> {
    const sb = getSandbox(this.opts.sandbox, await this.sandboxName());
    if (options.signal) {
      const onAbort = () => { void sb.killProcess(processId).catch(() => {}); };
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }
    const stream = await sb.streamProcessLogs(processId);
    return parseSSEStream<LogEvent>(stream);
  }

  /**
   * Look up a process by id. Returns null when the sandbox has lost the
   * process. Used by the agent's `onStart` recovery sweep to decide
   * whether to reattach or close out an in-flight exec.
   */
  async getProcess(processId: string): Promise<Process | null> {
    const sb = getSandbox(this.opts.sandbox, await this.sandboxName());
    try {
      return await sb.getProcess(processId);
    } catch {
      return null;
    }
  }

  /**
   * Pull file changes the container made into the VFS. Counterpart to
   * the automatic pull `exec` performs; for `startProcess` callers must
   * invoke this explicitly once they've decided the process is done
   * streaming. Returns the count of applied entries.
   */
  async pullDirtyAfter(): Promise<number> {
    return serialize(this.mutex, () => this._pullDirtyAfterLocked());
  }

  /**
   * Pull body without the mutex. exec() already holds the mutex when it
   * calls this; the public pullDirtyAfter() wraps it.
   */
  private async _pullDirtyAfterLocked(): Promise<number> {
    const api = await this.getConnection();

    // Pull files the container touched. Three cases per change, by the
    // mount root of its path:
    //   - outside any mount: applied to the VFS normally.
    //   - under a read-only mount: dropped (mounts are read-only end-to-end).
    //   - under a writable mount: applied to the VFS, then mirrored to R2.
    const ignore = this.opts.pullIgnore ?? ["node_modules"];

    // Prefer the manifest-aware pull . The container
    // ships one record per dirty path with (hash, size)[] per file — no
    // inline bytes. We then probe our own content-addressed store and
    // only ask the container for the bytes we don't already have.
    //
    // Fallback: an older container image that predates pullDirtyV2 only
    // exposes the legacy `pullDirty` (bytes-carrying bulk blob). capnweb
    // surfaces the missing method as `TypeError: '...' is not a function`
    // from inside its read loop. We catch *only* that shape so genuine
    // pull failures still propagate.
    let result: { changes: ApplyEntry[]; mirrors: MirrorEntry[]; maxRev: number };
    try {
      result = await this._pullDirtyV2(api, ignore);
    } catch (err) {
      if (!isMissingRpcMethod(err, "pullDirtyV2")) throw err;
      result = await this._pullDirtyLegacy(api, ignore);
    }
    const { changes: applyEntries, mirrors, maxRev } = result;

    if (applyEntries.length) {
      this.opts.storage.transactionSync(() => this.vfs.applyChangesSync(applyEntries));
    }
    // Advance the rev watermark even on an empty pull, so a successive
    // pull doesn't re-scan the same range. The container reports maxRev
    // = currentRev when nothing changed, so this is safe.
    this.pullSinceRev = maxRev;
    // Mirror writable-mount changes to R2 using the bytes we already
    // captured above, so we don't pay a second SQLite read per file.
    if (mirrors.length) {
      await this.runBounded(mirrors, async (m) => {
        if (m.op === "delete") {
          await m.mount.delete!(m.relPath);
        } else if (m.type === "file") {
          const bytes = m.bytes ?? this.vfs.readFile(m.path);
          if (bytes) await m.mount.put!(m.relPath, bytes);
        }
      });
    }

    this.saveWatermarks();
    return applyEntries.length;
  }

  /**
   * Manifest-aware pull. Returns the apply set, mirror set, and watermark
   * the caller should adopt. Pure data transform — no side effects on
   * `this.vfs` / `this.pullSinceRev`; `_pullDirtyAfterLocked` is the
   * single place that commits those.
   */
  private async _pullDirtyV2(
    api: ContainerRpc,
    ignore: string[],
  ): Promise<{ changes: ApplyEntry[]; mirrors: MirrorEntry[]; maxRev: number }> {
    const bulk = await api.pullDirtyV2(this.pullSinceRev, ignore);

    // Collect the union of chunk hashes across this pull, ask our own
    // Vfs which we lack, and fetch just those from the container.
    const allHashes = chunkHashUnion(bulk);
    const wantList  = this.vfs.missingBlobs(allHashes);
    const wantBytes = wantList.length ? await api.getBlobs(wantList) : [];
    const fetched = new Map<string, Uint8Array>();
    for (let i = 0; i < wantList.length; i++) {
      fetched.set(hashKey(wantList[i]), wantBytes[i]);
    }
    const lookup = (h: Uint8Array): Uint8Array | null => {
      return fetched.get(hashKey(h)) ?? this.vfs.readBlob(h);
    };

    const applyEntries: ApplyEntry[] = [];
    const mirrors:      MirrorEntry[] = [];
    for (const c of bulk.changes) {
      const e: ApplyEntry = { path: c.path, op: c.op };
      if (c.type  !== undefined) e.type  = c.type;
      if (c.mode  !== undefined) e.mode  = c.mode;
      if (c.mtime !== undefined) e.mtime = c.mtime;
      if (c.op === "upsert" && c.type === "file" && c.chunks) {
        // Every byte is content-verified by construction: the lookup
        // key IS the chunk hash.
        e.bytes = assembleFileBytes(c.chunks, lookup);
      }
      this._routeApplyEntry(e, applyEntries, mirrors);
    }
    return { changes: applyEntries, mirrors, maxRev: bulk.maxRev };
  }

  /**
   * Legacy bulk pull. Used when the container doesn't expose pullDirtyV2
   * (older image in front of a newer DO). Bytes ride inline in a single
   * bulk blob; no DO-side dedup. Same return shape as `_pullDirtyV2` so
   * the caller doesn't care which branch ran.
   */
  private async _pullDirtyLegacy(
    api: ContainerRpc,
    ignore: string[],
  ): Promise<{ changes: ApplyEntry[]; mirrors: MirrorEntry[]; maxRev: number }> {
    const bulk = await api.pullDirty(this.pullSinceRev, ignore);
    const blobBytes = await readStreamToUint8Array(bulk.blob);

    const applyEntries: ApplyEntry[] = [];
    const mirrors:      MirrorEntry[] = [];
    for (const c of bulk.changes) {
      const e: ApplyEntry = { path: c.path, op: c.op };
      if (c.type  !== undefined) e.type  = c.type;
      if (c.mode  !== undefined) e.mode  = c.mode;
      if (c.mtime !== undefined) e.mtime = c.mtime;
      if (c.op === "upsert" && c.type === "file" && c.contentSize !== undefined) {
        const off = c.contentOffset ?? 0;
        e.bytes = blobBytes.subarray(off, off + c.contentSize);
      }
      this._routeApplyEntry(e, applyEntries, mirrors);
    }
    return { changes: applyEntries, mirrors, maxRev: bulk.maxRev };
  }

  /**
   * Sort one apply entry into the VFS-apply list and/or the writable-
   * mount mirror list. Shared by the V2 and legacy pull paths.
   *   - outside any mount: applied to the VFS normally.
   *   - under a read-only mount: dropped (mounts are read-only end-to-end).
   *   - under a writable mount: applied to the VFS *and* mirrored to R2.
   */
  private _routeApplyEntry(
    e: ApplyEntry,
    applyEntries: ApplyEntry[],
    mirrors: MirrorEntry[],
  ): void {
    const root = this.mountRootOf(e.path);
    if (root === null) {
      applyEntries.push(e);
      return;
    }
    const mount = this.configuredMounts.get(root)!;
    if (!mount.writable) return;
    applyEntries.push(e);
    mirrors.push({ ...e, root, mount, relPath: e.path.slice(root.length + 1) });
  }

  /**
   * Run the worker-side mark-and-sweep GC to
   * reclaim orphan manifests and blobs left behind by overwrites and
   * deletes. Runs under the per-workspace mutex so it can never race
   * a writer mid-flight.
   *
   * Callers can pass a tighter safety window than
   * `Vfs.GC_DEFAULT_WINDOW_MS` (5 min) for tests or aggressive reclaim.
   */
  async gc(safetyWindowMs?: number): Promise<{ manifestsFreed: number; blobsFreed: number }> {
    return serialize(this.mutex, async () => this.vfs.gc(safetyWindowMs));
  }

  /**
   * Eagerly hydrate file content under one mount root, or all mounts if
   * omitted. Useful from `onStart()` if you want sync-ish reads immediately;
   * otherwise content is fetched on first read.
   */
  async prefetch(root?: string): Promise<void> {
    await this.ensureMountsIndexed();
    const stubs = this.vfs.listStubs()
      .filter(s => root === undefined || s.mountRoot === normalizeMountRoot(root))
      .map(s => s.path);
    if (stubs.length) await this.hydrateMany(stubs);
  }

  // ---- mount internals ----

  /** Resolve the configured mount root that owns `path`, or null. */
  private mountRootOf(path: string): string | null {
    for (const r of this.mountRoots) {
      if (path === r || path.startsWith(r + "/")) return r;
    }
    return null;
  }

  /**
   * Resolve `path` to its writable mount (root + mount + relPath) or null
   * if `path` is outside any mount. Throws EROFS if `path` is under a
   * read-only mount.
   */
  private resolveMountForWrite(path: string): { root: string; mount: Mount; relPath: string } | null {
    const root = this.mountRootOf(path);
    if (root === null) return null;
    const mount = this.configuredMounts.get(root)!;
    if (!mount.writable) {
      throw new Error(`EROFS: read-only mount at ${root}: ${path}`);
    }
    if (!mount.put || !mount.delete) {
      throw new Error(`mount ${root} is writable but missing put/delete`);
    }
    const relPath = path === root ? "" : path.slice(root.length + 1);
    return { root, mount, relPath };
  }

  /** Run `fn` over `items` with bounded concurrency. Aggregates errors. */
  private async runBounded<T>(items: T[], fn: (item: T) => Promise<void>): Promise<void> {
    if (items.length === 0) return;
    const limit = Workspace.FETCH_CONCURRENCY;
    const errors: unknown[] = [];
    let i = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        try { await fn(items[idx]); } catch (e) { errors.push(e); }
      }
    });
    await Promise.all(workers);
    if (errors.length) {
      const messages = errors.map(e => (e instanceof Error ? e.message : String(e))).join("; ");
      throw new Error(`bounded operation failed: ${messages}`);
    }
  }

  /**
   * Build the directory index for every configured mount that hasn't been
   * indexed yet. Concurrent callers share one promise; once resolved, the
   * `indexed` flag is persisted in `_workspace_mounts` so DO reloads skip
   * the re-list (stubs are already in `vfs_nodes`).
   */
  private ensureMountsIndexed(): Promise<void> {
    if (this.indexingPromise) return this.indexingPromise;
    const pending = this.mountRoots.filter(r => !this.mountIndexed.get(r));
    if (pending.length === 0) return Promise.resolve();

    this.indexingPromise = (async () => {
      for (const root of pending) {
        const mount = this.configuredMounts.get(root)!;
        const dirMode  = mount.writable ? 0o40755  : 0o40555;
        const fileMode = mount.writable ? 0o100644 : 0o100444;
        // Ensure the root itself exists as a directory before any work begins.
        this.vfs.mkdir(root, dirMode, root);

        if (mount.strategy === "eager") {
          // Eager mount: hand the mount a write API and let it materialize the
          // whole tree itself. The VFS holds real content (no stubs) when done.
          const api: MountWriteApi = {
            writeFile: (abs, bytes, mode) => {
              this.vfs.writeFile(abs, bytes, mode ?? fileMode, root);
            },
            mkdir: (abs, mode) => {
              this.vfs.mkdir(abs, mode ?? dirMode, root);
            },
          };
          await mount.materialize(api);
        } else {
          // Lazy mount: list + write stubs. Content fetched per-file on read.
          const entries = await mount.list();
          for (const entry of entries) {
            const abs = root + "/" + entry.relPath;
            if (entry.type === "dir") {
              this.vfs.mkdir(abs, dirMode, root);
            } else {
              this.vfs.writeStub(abs, fileMode, entry.mtime ?? Date.now(), root, entry.size ?? null);
            }
          }
        }

        this.mountIndexed.set(root, true);
        this.sql.exec(
          `UPDATE _workspace_mounts SET indexed = 1 WHERE root = ?`, root,
        );
      }
    })().finally(() => { this.indexingPromise = null; });
    return this.indexingPromise;
  }

  /**
   * Ensure a single stub's content is loaded into the VFS. No-op for
   * non-stub paths. Dedupes concurrent calls for the same path.
   */
  private ensureContentLoaded(path: string): Promise<void> {
    if (!this.vfs.isStub(path)) return Promise.resolve();
    const existing = this.contentFetches.get(path);
    if (existing) return existing;
    const root = this.vfs.getMountRoot(path);
    if (!root) return Promise.resolve();
    const mount = this.configuredMounts.get(root);
    if (!mount) throw new Error(`mount not configured for root: ${root}`);
    // Eager mounts materialize everything during indexing — a remaining stub
    // here means the file was deleted from the backing store between indexing
    // and this read, or the eager materialize() returned without writing it.
    // Either way there's nothing left to fetch.
    if (mount.strategy === "eager") return Promise.resolve();
    const relPath = path.slice(root.length + 1);
    const p = (async () => {
      const bytes = await mount.fetch(relPath);
      const mode = mount.writable ? 0o100644 : 0o100444;
      this.vfs.writeFile(path, bytes, mode, root);
    })().finally(() => { this.contentFetches.delete(path); });
    this.contentFetches.set(path, p);
    return p;
  }

  /** Hydrate multiple paths with bounded concurrency. Skips non-stubs. */
  private async hydrateMany(paths: string[]): Promise<void> {
    const stubs = paths.filter(p => this.vfs.isStub(p));
    if (stubs.length === 0) return;
    const limit = Workspace.FETCH_CONCURRENCY;
    let i = 0;
    const workers = Array.from({ length: Math.min(limit, stubs.length) }, async () => {
      while (i < stubs.length) {
        const idx = i++;
        await this.ensureContentLoaded(stubs[idx]);
      }
    });
    await Promise.all(workers);
  }

  // ---- internal: container process + capnweb session ----

  /**
   * Make sure `workspace-server` is running. Safe to call concurrently —
   * the in-flight promise is shared, and clears on rejection so callers can
   * retry. The orchestration logic lives in `container-startup.ts`; see the
   * doc comment on `ensureWorkspaceServer` for the failure modes it defends
   * against.
   */
  private async ensureContainerProcess(): Promise<void> {
    if (this.ensurePromise) return this.ensurePromise;
    const sb = getSandbox(this.opts.sandbox, await this.sandboxName());
    this.ensurePromise = ensureWorkspaceServer(sb, this.opts.port).catch(err => {
      this.ensurePromise = null;  // allow retry on next call
      throw err;
    });
    return this.ensurePromise;
  }

  /**
   * Get the active capnweb session, building a fresh one when the previous
   * connection has been torn down (or never existed). Survives DO restarts
   * because the container holds workspace-server across the gap; survives
   * mid-life WS drops because `ContainerConnection.onClose` nulls `this.conn`
   * synchronously and the next call rebuilds.
   */
  private async getConnection(): Promise<ContainerRpc> {
    await this.ensureContainerProcess();
    if (!this.conn) {
      const sb = getSandbox(this.opts.sandbox, await this.sandboxName());
      this.conn = new ContainerConnection({
        // `containerFetch` is the documented path for HTTP, but WebSocket upgrades
        // require `switchPort + fetch` (per @cloudflare/containers docs — see workerd #2319).
        stub: { fetch: (req: Request) => sb.fetch(req) },
        port: this.opts.port,
        onClose: () => { this.conn = null; },
      });
    }
    return this.conn.rpc() as unknown as ContainerRpc;  // capnweb RpcStub<T> is structurally T at the call site
  }

  private saveWatermarks(): void {
    // : persist the monotonic-revision watermark. The legacy
    // `pullSinceMs` row is intentionally left in place if present — it
    // does no harm (we don't read it) and DELETE-on-write would add a
    // round-trip on every exec for a one-time migration.
    this.sql.exec(
      `INSERT OR REPLACE INTO _workspace_watermark(k, v) VALUES ('pushSeq', ?), ('pullSinceRev', ?)`,
      this.pushSeq, this.pullSinceRev,
    );
  }
}

/**
 * Normalize a mount root: leading slash required, no trailing slash,
 * collapse duplicate slashes. Rejects relative paths and the bare root "/".
 */
function normalizeMountRoot(p: string): string {
  if (!p.startsWith("/")) throw new Error(`mount root must be absolute: ${p}`);
  let out = p.replace(/\/+/g, "/");
  if (out.length > 1 && out.endsWith("/")) out = out.slice(0, -1);
  if (out === "/") throw new Error(`mount root cannot be "/"`);
  return out;
}

/**
 * Drain a workerd ReadableStream<Uint8Array> into a single Uint8Array.
 * Used to materialize the bulk-pull blob before slicing per-file views.
 */
async function readStreamToUint8Array(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) { chunks.push(value); total += value.length; }
  }
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}
