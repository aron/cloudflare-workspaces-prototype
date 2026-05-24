/**
 * Workspace — Durable-Object-side facade combining:
 *   - a SQLite-backed VFS (Vfs)
 *   - incremental sync to a `@cloudflare/sandbox` container running the
 *     companion `container-sandbox` server
 *   - direct file ops that round-trip nothing through the container
 *
 * Construction is cheap: nothing networks until you call `exec()` or
 * `warmup()`. Sync watermarks (pushSeq / pullSinceMs) are persisted to the
 * DO storage so reconnects/restarts resume cleanly.
 */

import { getSandbox, type Sandbox } from "@cloudflare/sandbox";
import { switchPort } from "@cloudflare/containers";
import { newWebSocketRpcSession } from "capnweb";

import { Vfs } from "./vfs.js";
import type { Mount } from "./mounts/index.js";
import type { ContainerRpc, ExecResult, GrepHit, FileStat, VfsChange } from "./shared/index.js";

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
  mounts?: Record<string, Mount>;
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

export class Workspace {
  readonly vfs: Vfs;
  private opts: WorkspaceOptions & { port: number };
  private sql: SqlStorage;
  /** Cached result of resolveSessionId(opts.sessionId). null until first lookup. */
  private resolvedSandboxName: string | null = null;

  // Sync watermarks (persisted in _workspace_watermark)
  private pushSeq     = 0;  // last VFS `seq` pushed to the container
  private pullSinceMs = 0;  // last container-side mtime seen on pull

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

  constructor(opts: WorkspaceOptions) {
    this.opts = { port: 4567, ...opts };
    this.sql = (opts.storage as DurableObjectStorage & { sql: SqlStorage }).sql;
    this.vfs = new Vfs(this.sql);
    this.sql.exec(WATERMARK_TABLE);
    for (const r of this.sql.exec(`SELECT k, v FROM _workspace_watermark`) as Iterable<{ k: string; v: number }>) {
      if (r.k === "pushSeq")     this.pushSeq     = r.v;
      if (r.k === "pullSinceMs") this.pullSinceMs = r.v;
    }

    // Normalize and reconcile configured mounts against the persisted state.
    // Anything in the table that no longer matches the configured mount kind
    // (or is no longer configured at all) gets its subtree wiped — we'll
    // re-index on demand.
    const configured = new Map<string, Mount>();
    for (const [rawRoot, mount] of Object.entries(opts.mounts ?? {})) {
      const root = normalizeMountRoot(rawRoot);
      if (configured.has(root)) throw new Error(`duplicate mount root: ${root}`);
      configured.set(root, mount);
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
    await this.ensureMountsIndexed();
    await this.ensureContentLoaded(path);
    return this.vfs.readFile(path);
  }

  async writeFile(path: string, content: Uint8Array | string, mode?: number): Promise<void> {
    await this.ensureMountsIndexed();
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
    const m = this.resolveMountForWrite(path);
    if (m) {
      // Push to the backing store first — if it fails, the VFS stays clean.
      await m.mount.put!(m.relPath, bytes);
      this.vfs.writeFile(path, bytes, mode ?? 0o100644, m.root);
    } else {
      this.vfs.writeFile(path, bytes, mode);
    }
  }

  async readdir(path: string): Promise<Array<{ name: string; type: "file" | "dir" }>> {
    await this.ensureMountsIndexed();
    return this.vfs.readdir(path);
  }

  async stat(path: string): Promise<FileStat | null> {
    await this.ensureMountsIndexed();
    return this.vfs.stat(path);
  }

  async mkdir(path: string, mode?: number): Promise<void> {
    await this.ensureMountsIndexed();
    // mkdir is VFS-only even under writable mounts: R2 has no directories,
    // and synthesizing zero-byte directory markers would surface as files.
    const m = this.resolveMountForWrite(path);
    this.vfs.mkdir(path, mode, m ? m.root : null);
  }

  async deleteFile(path: string): Promise<void> {
    await this.ensureMountsIndexed();
    const m = this.resolveMountForWrite(path);
    if (m) {
      // Collect every file under `path` (could be a single file or a subtree)
      // and delete each from the backing store before touching the VFS.
      const subtree = this.vfs.listFilesUnder(path);
      const files   = subtree.length ? subtree : (this.vfs.stat(path)?.type === "file" ? [path] : []);
      const rels    = files.map(f => f.slice(m.root.length + 1));
      await this.runBounded(rels, r => m.mount.delete!(r));
    }
    this.vfs.deleteFile(path);
  }

  async listFilesUnder(prefix: string): Promise<string[]> {
    await this.ensureMountsIndexed();
    return this.vfs.listFilesUnder(prefix);
  }

  /** Search filenames under `directory` for `pattern` (substring match). */
  async findFiles(directory: string, pattern?: string): Promise<Array<{ path: string; type: "file" | "dir" }>> {
    await this.ensureMountsIndexed();
    return this.vfs.snapshot().entries
      .filter(e => e.path.startsWith(directory))
      .filter(e => !pattern || e.path.includes(pattern))
      .map(e => ({ path: e.path, type: e.type }));
  }

  /** Grep file contents for `pattern`. `path` may be a file or directory. */
  async grep(pattern: string, path: string, opts: { ignoreCase?: boolean } = {}): Promise<GrepHit[]> {
    await this.ensureMountsIndexed();
    const needle = opts.ignoreCase ? pattern.toLowerCase() : pattern;
    const { entries } = this.vfs.snapshot();
    const files = entries.filter(e => e.type === "file" && e.path.startsWith(path));
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
    const sb = getSandbox(this.opts.sandbox, await this.sandboxName());
    using api = await this.connectContainer();

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

    // Pull files the container touched. Three cases per change, by the
    // mount root of its path:
    //   - outside any mount: applied to the VFS normally.
    //   - under a read-only mount: dropped (mounts are read-only end-to-end).
    //   - under a writable mount: applied to the VFS, then mirrored to R2.
    const dirtyRaw = await api.getDirtyNodes(this.pullSinceMs);
    const accepted: VfsChange[] = [];
    const mirrors: Array<{ change: VfsChange; root: string; mount: Mount; relPath: string }> = [];
    for (const c of dirtyRaw) {
      const root = this.mountRootOf(c.path);
      if (root === null) {
        accepted.push(c);
        continue;
      }
      const mount = this.configuredMounts.get(root)!;
      if (!mount.writable) continue;  // read-only mount: drop
      accepted.push(c);
      const relPath = c.path.slice(root.length + 1);
      mirrors.push({ change: c, root, mount, relPath });
    }
    if (accepted.length) {
      await this.vfs.applyChanges(accepted);
      this.pullSinceMs = Math.max(this.pullSinceMs, ...accepted.map(d => d.mtime ?? 0));
    }
    // Mirror writable-mount changes to R2 *after* the VFS has the new bytes,
    // so we can read them back chunk-by-chunk rather than buffering streams.
    if (mirrors.length) {
      await this.runBounded(mirrors, async (m) => {
        if (m.change.op === "delete") {
          await m.mount.delete!(m.relPath);
        } else if (m.change.type === "file") {
          const bytes = this.vfs.readFile(m.change.path);
          if (bytes) await m.mount.put!(m.relPath, bytes);
        }
        // dir entries are VFS-only; nothing to mirror.
      });
    }

    this.saveWatermarks();

    return {
      exitCode: result.exitCode,
      stdout:   result.stdout,
      stderr:   result.stderr,
      pushed:   changes.length,
      pulled:   accepted.length,
    };
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
        const entries = await mount.list();
        const dirMode  = mount.writable ? 0o40755  : 0o40555;
        const fileMode = mount.writable ? 0o100644 : 0o100444;
        // Ensure the root itself exists as a directory.
        this.vfs.mkdir(root, dirMode, root);
        for (const entry of entries) {
          const abs = root + "/" + entry.relPath;
          if (entry.type === "dir") {
            this.vfs.mkdir(abs, dirMode, root);
          } else {
            this.vfs.writeStub(abs, fileMode, entry.mtime ?? Date.now(), root, entry.size ?? null);
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

  private async ensureContainerProcess(): Promise<void> {
    const sb = getSandbox(this.opts.sandbox, await this.sandboxName());
    let proc;
    try {
      proc = await sb.getProcess("workspace-server");
    } catch {
      proc = null;
    }
    if (!proc) {
      proc = await sb.startProcess("node /app/server.cjs", { processId: "workspace-server" });
    }
    await proc.waitForPort(this.opts.port);
  }

  async connectContainer(retries = 8, delayMs = 1500): Promise<ContainerRpc & Disposable> {
    await this.ensureContainerProcess();
    const sb = getSandbox(this.opts.sandbox, await this.sandboxName());
    const wsReq = new Request("http://container/rpc", {
      headers: { Upgrade: "websocket", Connection: "upgrade" },
    });
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const wsRes = await sb.fetch(switchPort(wsReq.clone(), this.opts.port));
        const ws = (wsRes as unknown as { webSocket: WebSocket }).webSocket;
        // Dispose the Response stub now that we've extracted the WS, so
        // workerd doesn't warn at hibernate time.
        try { (wsRes as unknown as Disposable)[Symbol.dispose]?.(); } catch { /* older runtimes */ }
        if (!ws) throw new Error("no WebSocket in upgrade response");
        ws.accept();
        return newWebSocketRpcSession<ContainerRpc>(ws as unknown as WebSocket);
      } catch (err) {
        if (attempt === retries) {
          throw new Error(`Container not ready after ${retries} attempts: ${err}`);
        }
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
    throw new Error("unreachable");
  }

  private saveWatermarks(): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO _workspace_watermark(k, v) VALUES ('pushSeq', ?), ('pullSinceMs', ?)`,
      this.pushSeq, this.pullSinceMs,
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
