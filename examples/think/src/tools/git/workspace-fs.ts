/**
 * Node-fs-shaped adapter that lets isomorphic-git read and write
 * directly against `@cloudflare/workspace`'s filesystem.
 *
 * isomorphic-git expects an object shaped like
 * `{ promises: { readFile, writeFile, unlink, readdir, mkdir, rmdir,
 *   stat, lstat, readlink, symlink } }`. Every method except
 * `readlink`/`symlink` is wired through to `ws.fs.*` — we don't model
 * symlinks (the workspace VFS doesn't either).
 *
 * A byte budget is enforced inside `writeFile` — when the running
 * total exceeds `maxBytes` we throw `EFBIG`, aborting the clone
 * before it can fill workerd's heap with a giant packfile.
 */

import type { WorkspaceLike } from "../fs/stores/workspace.js";

interface Stat {
  type: "file" | "dir";
  mode: number;
  size: number;
  ino: number;
  mtimeMs: number;
  ctimeMs: number;
  uid: number;
  gid: number;
  dev: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface WorkspaceGitFsOptions {
  /** Hard cap on bytes written through this adapter. */
  maxBytes: number;
}

export class WorkspaceGitFs {
  bytesWritten = 0;
  readonly promises: {
    readFile: (
      path: string,
      options?: { encoding?: "utf8" } | string,
    ) => Promise<Uint8Array | string>;
    writeFile: (path: string, data: Uint8Array | string, options?: unknown) => Promise<void>;
    unlink: (path: string) => Promise<void>;
    readdir: (path: string) => Promise<string[]>;
    mkdir: (path: string, options?: { recursive?: boolean }) => Promise<void>;
    rmdir: (path: string) => Promise<void>;
    stat: (path: string) => Promise<Stat>;
    lstat: (path: string) => Promise<Stat>;
    readlink: (path: string) => Promise<string>;
    symlink: () => Promise<void>;
  };

  constructor(
    private readonly ws: WorkspaceLike,
    private readonly opts: WorkspaceGitFsOptions,
  ) {
    this.promises = {
      readFile: this.readFile.bind(this),
      writeFile: this.writeFile.bind(this),
      unlink: this.unlink.bind(this),
      readdir: this.readdir.bind(this),
      mkdir: this.mkdir.bind(this),
      rmdir: this.rmdir.bind(this),
      stat: this.stat.bind(this),
      lstat: this.stat.bind(this),
      readlink: async (path: string) => {
        throw enoent(path); // no symlinks in the workspace VFS
      },
      symlink: async () => {
        throw new Error("symlink not supported");
      },
    };
  }

  private async readFile(
    path: string,
    options?: { encoding?: "utf8" } | string,
  ): Promise<Uint8Array | string> {
    const encoding = typeof options === "string" ? options : options?.encoding;
    let stream: ReadableStream<Uint8Array>;
    try {
      stream = await this.ws.fs.readFile(path);
    } catch (err) {
      throw mapErr(err, path);
    }
    const bytes = await drain(stream);
    if (encoding === "utf8") return new TextDecoder().decode(bytes);
    return bytes;
  }

  private async writeFile(
    path: string,
    data: Uint8Array | string,
    _options?: unknown,
  ): Promise<void> {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    this.bytesWritten += bytes.byteLength;
    if (this.bytesWritten > this.opts.maxBytes) {
      throw efbig(path, this.bytesWritten, this.opts.maxBytes);
    }
    const parent = parentOf(path);
    if (parent && parent !== "/") {
      await this.ws.fs.mkdir(parent, { recursive: true });
    }
    await this.ws.fs.writeFile(path, bytes);
  }

  private async unlink(path: string): Promise<void> {
    try {
      await this.ws.fs.rm(path, { force: true });
    } catch (err) {
      throw mapErr(err, path);
    }
  }

  private async readdir(path: string): Promise<string[]> {
    try {
      const entries = await this.ws.fs.readdir(path);
      return entries.map((e) => e.name);
    } catch (err) {
      throw mapErr(err, path);
    }
  }

  private async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    await this.ws.fs.mkdir(path, { recursive: options?.recursive ?? false });
  }

  private async rmdir(path: string): Promise<void> {
    try {
      await this.ws.fs.rm(path, { recursive: true, force: true });
    } catch (err) {
      throw mapErr(err, path);
    }
  }

  private async stat(path: string): Promise<Stat> {
    try {
      const s = await this.ws.fs.stat(path);
      const isFile = s.isFile;
      return {
        type: isFile ? "file" : "dir",
        mode: isFile ? s.mode : s.mode | 0o040000,
        size: s.size,
        ino: 0,
        mtimeMs: s.mtime,
        ctimeMs: s.mtime,
        uid: 0,
        gid: 0,
        dev: 0,
        isFile: () => isFile,
        isDirectory: () => !isFile,
        isSymbolicLink: () => false,
      };
    } catch (err) {
      throw mapErr(err, path);
    }
  }
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        parts.push(value);
        total += value.byteLength;
      }
    }
  } finally {
    reader.releaseLock();
  }
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

function parentOf(p: string): string | null {
  const i = p.lastIndexOf("/");
  if (i <= 0) return "/";
  return p.slice(0, i);
}

interface FsError extends Error {
  code: string;
  errno: number;
  path: string;
}

function fsError(code: string, errno: number, path: string): FsError {
  const err = new Error(`${code}: ${path}`) as FsError;
  err.code = code;
  err.errno = errno;
  err.path = path;
  return err;
}

function enoent(path: string): FsError {
  return fsError("ENOENT", -2, path);
}

function efbig(path: string, written: number, cap: number): FsError {
  return fsError("EFBIG", -27, `${path} — exceeded byte budget (${written} > ${cap})`);
}

function mapErr(err: unknown, path: string): Error {
  if (!err || typeof err !== "object") return err as Error;
  const e = err as { code?: string; message?: string };
  if (e.code === "ENOENT" || (typeof e.message === "string" && /ENOENT|no such/i.test(e.message))) {
    return enoent(path);
  }
  return err as Error;
}
