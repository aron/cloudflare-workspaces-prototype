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
}

const WATERMARK_TABLE = `
CREATE TABLE IF NOT EXISTS _workspace_watermark (
  k TEXT PRIMARY KEY,
  v INTEGER NOT NULL
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

  constructor(opts: WorkspaceOptions) {
    this.opts = { port: 4567, ...opts };
    this.sql = (opts.storage as DurableObjectStorage & { sql: SqlStorage }).sql;
    this.vfs = new Vfs(this.sql);
    this.sql.exec(WATERMARK_TABLE);
    for (const r of this.sql.exec(`SELECT k, v FROM _workspace_watermark`) as Iterable<{ k: string; v: number }>) {
      if (r.k === "pushSeq")     this.pushSeq     = r.v;
      if (r.k === "pullSinceMs") this.pullSinceMs = r.v;
    }
  }

  /** Resolve and cache the sandbox DO name (UUID when using a warm pool). */
  private async sandboxName(): Promise<string> {
    if (this.resolvedSandboxName !== null) return this.resolvedSandboxName;
    const resolve = this.opts.resolveSessionId;
    this.resolvedSandboxName = resolve ? await resolve(this.opts.sessionId) : this.opts.sessionId;
    return this.resolvedSandboxName;
  }

  // ---- direct VFS (no container round-trip) ----

  readFile(path: string): Uint8Array | null              { return this.vfs.readFile(path); }
  writeFile(path: string, content: Uint8Array | string, mode?: number): void {
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
    this.vfs.writeFile(path, bytes, mode);
  }
  readdir(path: string): Array<{ name: string; type: "file" | "dir" }> { return this.vfs.readdir(path); }
  stat(path: string): FileStat | null                    { return this.vfs.stat(path); }
  mkdir(path: string, mode?: number): void               { this.vfs.mkdir(path, mode); }
  deleteFile(path: string): void                         { this.vfs.deleteFile(path); }
  listFilesUnder(prefix: string): string[]               { return this.vfs.listFilesUnder(prefix); }

  /** Search filenames under `directory` for `pattern` (substring match). */
  findFiles(directory: string, pattern?: string): Array<{ path: string; type: "file" | "dir" }> {
    return this.vfs.snapshot().entries
      .filter(e => e.path.startsWith(directory))
      .filter(e => !pattern || e.path.includes(pattern))
      .map(e => ({ path: e.path, type: e.type }));
  }

  /** Grep file contents for `pattern`. `path` may be a file or directory. */
  grep(pattern: string, path: string, opts: { ignoreCase?: boolean } = {}): GrepHit[] {
    const needle = opts.ignoreCase ? pattern.toLowerCase() : pattern;
    const { entries } = this.vfs.snapshot();
    const files = entries.filter(e => e.type === "file" && e.path.startsWith(path));
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
    const sb = getSandbox(this.opts.sandbox, await this.sandboxName());
    using api = await this.connectContainer();

    // Push the delta since the last exec.
    const changes = this.vfs.getChangesSince(this.pushSeq);
    if (changes.length) {
      await api.applyChanges(changes);
      this.pushSeq = changes[changes.length - 1].seq;
    }

    const result = await sb.exec(command, { cwd: cwd ?? "/tmp" });

    // Pull files the container touched.
    const dirty = await api.getDirtyNodes(this.pullSinceMs);
    if (dirty.length) {
      await this.vfs.applyChanges(dirty);
      this.pullSinceMs = Math.max(this.pullSinceMs, ...dirty.map(d => d.mtime ?? 0));
    }

    this.saveWatermarks();

    return {
      exitCode: result.exitCode,
      stdout:   result.stdout,
      stderr:   result.stderr,
      pushed:   changes.length,
      pulled:   dirty.length,
    };
  }

  /**
   * Pre-warm the container without running a command. Idempotent.
   * Use from `onStart()` in `ctx.waitUntil(...)` so the first exec is fast.
   */
  async warmup(): Promise<void> {
    await this.ensureContainerProcess();
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
