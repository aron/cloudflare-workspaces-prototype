/**
 * Container sync server.
 *
 * Single process — fuse-native + capnweb do NOT deadlock in the same
 * event loop. fuse-native serves callbacks via libuv threads independently.
 *
 * Boot sequence:
 *   1. Mount FUSE at /workspace backed by an in-memory VFS.
 *   2. Start HTTP + WebSocket server on PORT (4567).
 *   3. Each WS connection gets a capnweb session with ContainerRpc.
 */

declare const require: NodeRequire;
(globalThis as any).WebSocket = require('ws');

import fs from 'fs';
import { spawn } from 'child_process';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { newWebSocketRpcSession, RpcTarget } from 'capnweb';
import { createWriteStream } from 'fs';
import { Vfs } from './vfs.js';
import { mount } from './fuse-driver.js';
import type { VfsEntry, VfsChange, VfsChangeLite, DirtyBulk, ManifestBulk } from '../shared/index.js';

const LOG_FILE = process.env.LOG_FILE ?? '/tmp/server.log';
const logStream = createWriteStream(LOG_FILE, { flags: 'a' });
function log(...args: unknown[]) {
  const line = `${new Date().toISOString()} ${args.map(String).join(' ')}\n`;
  logStream.write(line);
}

process.on('uncaughtException',  (err)    => { log('[fatal] uncaughtException:', err);    process.exit(1); });
process.on('unhandledRejection', (reason) => { log('[fatal] unhandledRejection:', reason); process.exit(1); });

const MOUNT = process.env.MOUNT_POINT ?? '/workspace';
const PORT  = parseInt(process.env.PORT ?? '4567');

// ---- stream helpers ----

function bufToStream(buf: Uint8Array): ReadableStream<Uint8Array> {
  // Normalize Buffer (a Node subclass of Uint8Array) to plain Uint8Array for
  // the workerd-flavored ReadableStream consumer.
  const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  return new ReadableStream<Uint8Array>({ start(c) { c.enqueue(u8); c.close(); } });
}

async function streamToBuffer(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return out;
}

// Pull-scope matcher used by getDirtyNodes / pullDirty.  See ./ignore.ts.
import { makeIgnore } from './ignore.js';
import { computeBulkPull, computeDirtyNodes, computeManifestPull, getBlobs as readBlobs, missingBlobs } from './pull.js';

// ---- RpcTarget served to the DO ----

class ContainerRpc extends RpcTarget {
  constructor(private vfs: Vfs, private fuseActive: boolean) { super(); }

  async snapshot(): Promise<{ entries: VfsEntry[]; seq: number }> {
    const entries: VfsEntry[] = [];
    for (const { path, node } of this.vfs.allFiles()) {
      if (node.type === 'symlink') continue;  // symlinks aren't part of the wire
      const entry: VfsEntry = { path, type: node.type, mode: node.mode, mtime: node.mtime };
      if (node.type === 'file') entry.content = bufToStream(node.buf.slice(0, node.size));
      entries.push(entry);
    }
    return { entries, seq: 0 };
  }

  async applyChanges(changes: VfsChange[]): Promise<{ seq: number }> {
    // Suppress tombstone recording while we apply remote changes — otherwise
    // deletes pushed down by the DO would bounce right back on the next pull.
    this.vfs.applying = true;
    try {
      for (const c of changes) {
        if (c.op === 'delete') {
          this.vfs.delete(c.path);
          if (!this.fuseActive) {
            try { fs.rmSync(MOUNT + c.path, { recursive: true, force: true }); } catch {}
          }
        } else if (c.type === 'dir') {
          this.vfs.mkdir(c.path, c.mode);
          if (!this.fuseActive) fs.mkdirSync(MOUNT + c.path, { recursive: true });
        } else {
          const buf = c.content ? Buffer.from(await streamToBuffer(c.content)) : Buffer.alloc(0);
          this.vfs.putFile(c.path, buf, c.mode);
          if (!this.fuseActive) {
            const diskPath = MOUNT + c.path;
            fs.mkdirSync(diskPath.slice(0, diskPath.lastIndexOf('/')), { recursive: true });
            fs.writeFileSync(diskPath, buf);
          }
        }
      }
    } finally {
      this.vfs.applying = false;
    }
    return { seq: 0 };
  }

  async exec(command: string, cwd?: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    log(`[exec] ${command}`);
    // Yield the event loop before spawning so libuv threads (including
    // fuse-native's /dev/fuse poll thread) get scheduled first.
    await new Promise(r => setImmediate(r));
    return new Promise(resolve => {
      let stdout = '';
      let stderr = '';
      const child = spawn('sh', ['-c', command], {
        cwd: cwd ?? '/tmp',  // never cwd into the FUSE mount — spawning resolves cwd via getattr
        env: {
          ...process.env,
          HOME: '/root',
          PATH: (process.env.PATH ?? '') + ':/usr/local/bin',
        },
      });
      child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
      child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
      child.on('close', code => {
        log(`[exec] exit=${code}`);
        resolve({ exitCode: code ?? 1, stdout, stderr });
      });
    });
  }

  /**
   * Bulk-transport pull: same selection as getDirtyNodes() but content
   * is concatenated into a single blob.  Each VfsChangeLite carries the
   * offset and size of its file's bytes inside the blob.  This avoids
   * capnweb materializing one stream per file (the dominant cost of the
   * old protocol at 1000+ file scale).
   */
  async pullDirty(since = 0, ignore?: string[]): Promise<DirtyBulk> {
    if (this.fuseActive) {
      const { changes, blob, maxRev } = computeBulkPull(this.vfs, since, ignore);
      // Clear dirty state for every file we shipped.  Optimistic: if
      // the DO's apply fails the file's rev is still > since so the
      // next pull catches it again — just in whole-file mode this time.
      // Symmetric to the existing watermark-advances-on-success rule.
      for (const c of changes) {
        if (c.op === "upsert" && c.type === "file") this.vfs.dirty.clear(c.path);
      }
      return { changes, blob: bufToStream(blob), maxRev };
    }
    // No-FUSE fallback: scan the real /workspace directory.  Same wire
    // shape as the FUSE path so the DO doesn't need to know which side
    // produced the result.  This path retains millisecond-mtime
    // selection (no in-memory Vfs to provide a monotonic rev); it is
    // dev/test only. The maxRev we return is the largest mtime seen,
    // which is correct for watermark advancement modulo the same-ms
    // race fixes for the FUSE path.
    const isIgnored = makeIgnore(ignore);
    type Entry = { ts: number; change: VfsChangeLite; buf?: Buffer };
    const entries: Entry[] = [];
    const stack: string[] = [MOUNT];
    let maxMs = since;
    while (stack.length) {
      const dir = stack.pop()!;
      let dirents: fs.Dirent[];
      try { dirents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const ent of dirents) {
        const abs = dir + '/' + ent.name;
        if (isIgnored(abs)) continue;
        if (ent.isDirectory()) {
          const st = fs.statSync(abs);
          if (st.mtimeMs > since) {
            if (st.mtimeMs > maxMs) maxMs = st.mtimeMs;
            entries.push({ ts: st.mtimeMs, change: { seq: 0, path: abs, op: 'upsert', type: 'dir', mode: 0o40755, mtime: st.mtimeMs } });
          }
          stack.push(abs);
        } else if (ent.isFile()) {
          const st = fs.statSync(abs);
          if (st.mtimeMs > since) {
            if (st.mtimeMs > maxMs) maxMs = st.mtimeMs;
            const buf = fs.readFileSync(abs);
            entries.push({
              ts: st.mtimeMs,
              change: { seq: 0, path: abs, op: 'upsert', type: 'file', mode: 0o100644, mtime: st.mtimeMs, contentOffset: 0, contentSize: buf.length },
              buf,
            });
          }
        }
      }
    }
    entries.sort((a, b) => a.ts - b.ts);
    const fileEntries = entries.filter(e => e.buf !== undefined);
    const totalBytes = fileEntries.reduce((n, e) => n + (e.buf!.length), 0);
    const blob = Buffer.allocUnsafe(totalBytes);
    let off = 0;
    for (const e of fileEntries) {
      e.change.contentOffset = off;
      e.change.contentSize = e.buf!.length;
      e.buf!.copy(blob, off);
      off += e.buf!.length;
    }
    const changes: VfsChangeLite[] = entries.map((e, i) => ({ ...e.change, seq: i }));
    return { changes, blob: bufToStream(blob), maxRev: maxMs };
  }

  async getDirtyNodes(since = 0, ignore?: string[]): Promise<VfsChange[]> {
    if (this.fuseActive) {
      return computeDirtyNodes(this.vfs, since, ignore).map(({ change, bytes }) => ({
        ...change,
        content: bytes ? bufToStream(bytes) : undefined,
      }));
    }
    const isIgnored = makeIgnore(ignore);
    // No FUSE: scan real /workspace, filter by mtime
    const results: VfsChange[] = [];
    let seq = 0;
    function scan(dir: string) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = dir + '/' + entry.name;
        if (isIgnored(abs)) continue;
        if (entry.isDirectory()) {
          const st = fs.statSync(abs);
          if (st.mtimeMs > since)
            results.push({ seq: seq++, path: abs, op: 'upsert', type: 'dir', mode: 0o40755, mtime: st.mtimeMs });
          scan(abs);
        } else if (entry.isFile()) {
          const st = fs.statSync(abs);
          if (st.mtimeMs > since) {
            const buf = fs.readFileSync(abs);
            results.push({ seq: seq++, path: abs, op: 'upsert', type: 'file',
              mode: 0o100644, mtime: st.mtimeMs, content: bufToStream(buf) });
          }
        }
      }
    }
    try { scan(MOUNT); } catch {}
    return results;
  }

  // ---- : manifest-aware pull --------------------

  async pullDirtyV2(sinceRev = 0, ignore?: string[]): Promise<ManifestBulk> {
    if (!this.fuseActive) {
      // The no-FUSE fallback has no in-memory Vfs to source chunk
      // hashes from. Callers that hit this branch should stay on
      // pullDirty (bytes-carrying) until we add a fallback hasher.
      throw new Error('pullDirtyV2 requires FUSE-active mode');
    }
    const out = computeManifestPull(this.vfs, sinceRev, ignore);
    // Optimistic clear of dirty state, same contract as pullDirty:
    // if the DO's apply fails the file's rev is still > sinceRev so
    // the next pull catches it again.
    for (const c of out.changes) {
      if (c.op === 'upsert' && c.type === 'file') this.vfs.dirty.clear(c.path);
    }
    return out;
  }

  async hasBlobs(hashes: Uint8Array[]): Promise<Uint8Array[]> {
    if (!this.fuseActive) throw new Error('hasBlobs requires FUSE-active mode');
    // Container reports MISSING hashes — caller subtracts mentally:
    // requested - missing = present. We picked this direction so the
    // typical case (peer mostly has nothing) ships short payloads.
    return missingBlobs(this.vfs, hashes);
  }

  async getBlobs(hashes: Uint8Array[]): Promise<Uint8Array[]> {
    if (!this.fuseActive) throw new Error('getBlobs requires FUSE-active mode');
    return readBlobs(this.vfs, hashes).map(b => new Uint8Array(b.buffer, b.byteOffset, b.byteLength));
  }

}

// ---- main ----

async function main() {
  log(`[boot] node ${process.version}, pid ${process.pid}`);
  log(`[boot] MOUNT=${MOUNT} PORT=${PORT}`);

  const vfs = new Vfs();
  // Pre-create the mount root in the VFS so FUSE's getattr('/') — which maps
  // to vfs.get(MOUNT) via the driver's path translation — doesn't return
  // ENOENT for the FUSE root inode itself, which would make the mount appear
  // empty / inaccessible to userspace (`ls /workspace` => No such file).
  vfs.mkdir(MOUNT);
  fs.mkdirSync(MOUNT, { recursive: true });
  let fuseActive = false;
  try {
    await mount(MOUNT, vfs);
    fuseActive = true;
    log(`[boot] FUSE mounted at ${MOUNT}`);
  } catch (err) {
    log(`[boot] FUSE unavailable: ${(err as Error).message} — using plain dir`);
  }

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url!, `http://localhost:${PORT}`);
    log(`[http] ${req.method} ${url.pathname}`);

    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', fuse: fuseActive, port: PORT, node: process.version }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/exec') {
      let body = '';
      req.on('data', (d: Buffer) => { body += d.toString(); });
      req.on('end', async () => {
        try {
          const { command, cwd } = JSON.parse(body);
          const rpc = new ContainerRpc(vfs, fuseActive);
          const result = await rpc.exec(command, cwd);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (e) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: String(e) }));
        }
      });
      return;
    }

    res.writeHead(404); res.end('not found');
  });

  httpServer.on('error', (err) => log('[http] error:', err));

  const wss = new WebSocketServer({ server: httpServer });
  wss.on('connection', (ws, req) => {
    log(`[rpc] client connected from ${req.socket.remoteAddress}`);
    ws.on('error', (err) => log('[rpc] ws error:', err));
    ws.on('close', (code) => log(`[rpc] client disconnected (${code})`));
    // Wrap WebSocket to inject a setImmediate yield between each capnweb
    // message. Without this, capnweb's readLoop resolves a chain of
    // already-queued microtasks without returning to the libuv event loop,
    // starving fuse-native's uv_async callbacks and deadlocking FUSE access.
    const wsYielding = new Proxy(ws, {
      get(target: any, prop: string) {
        if (prop !== 'addEventListener') return target[prop];
        return (event: string, handler: Function) => {
          if (event !== 'message') return target.addEventListener(event, handler);
          target.addEventListener('message', async (ev: any) => {
            await new Promise(r => setImmediate(r));
            handler(ev);
          });
        };
      },
    });
    newWebSocketRpcSession(wsYielding as any, new ContainerRpc(vfs, fuseActive));
  });

  httpServer.listen(PORT, '0.0.0.0', () => {
    log(`[boot] listening on :${PORT} (fuse=${fuseActive})`);
  });
}

main().catch(err => { log('[fatal] main():', err); process.exit(1); });
