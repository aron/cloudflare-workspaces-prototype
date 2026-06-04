// Read-only mount enforcement layer.
//
// Wraps a WorkspaceFilesystem and rejects writes whose path falls
// under a read-only mount root with EROFS. The check is a simple
// prefix match against the registered roots; nested mount roots
// are rejected at registration so a path has at most one owning
// mount.
//
// Reads are forwarded unchanged. Writes under writable mount roots
// also pass through; the write-back mirror is wired in a later
// milestone.

import type {
  GrepOptions,
  MkdirOptions,
  ReadFileOptions,
  RmOptions,
  WorkspaceDirentResult,
  WorkspaceFoundEntry,
  WorkspaceGrepMatch,
  WorkspaceStatResult,
  WriteFileContent,
  WriteFileOptions,
} from "@cloudflare/dofs";
import { createWorkspaceError, WorkspaceFilesystem } from "@cloudflare/dofs";

import type { Mount } from "./types.js";

function isUnderRoot(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

export class GuardedWorkspaceFilesystem extends WorkspaceFilesystem {
  readonly #inner: WorkspaceFilesystem;
  readonly #mounts: Map<string, Mount>;

  constructor(inner: WorkspaceFilesystem, mounts: Map<string, Mount>) {
    super(inner.db, { now: inner.now });
    this.#inner = inner;
    this.#mounts = mounts;
  }

  #checkWrite(path: string): void {
    for (const [root, mount] of this.#mounts) {
      if (isUnderRoot(path, root) && mount.mode === "read-only") {
        throw createWorkspaceError("EROFS", `read-only mount at ${root}: cannot modify`, path);
      }
    }
  }

  // Reads: forward unchanged.
  readFile(path: string): Promise<ReadableStream<Uint8Array>>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  readFile(path: string, options: ReadFileOptions): Promise<string | ReadableStream<Uint8Array>>;
  readFile(
    path: string,
    optionsOrEncoding?: "utf8" | ReadFileOptions,
  ): Promise<string | ReadableStream<Uint8Array>> {
    return this.#inner.readFile(path, optionsOrEncoding as ReadFileOptions);
  }

  stat(path: string): Promise<WorkspaceStatResult> {
    return this.#inner.stat(path);
  }

  readdir(path: string): Promise<WorkspaceDirentResult[]> {
    return this.#inner.readdir(path);
  }

  find(directory: string, pattern?: string): Promise<WorkspaceFoundEntry[]> {
    return this.#inner.find(directory, pattern);
  }

  ls(prefix: string): Promise<string[]> {
    return this.#inner.ls(prefix);
  }

  grep(pattern: string, path: string, options: GrepOptions = {}): Promise<WorkspaceGrepMatch[]> {
    return this.#inner.grep(pattern, path, options);
  }

  // Writes: guarded. The guard throw is wrapped in an async function
  // so callers see a rejected Promise rather than a synchronous
  // throw — matches the behaviour of the underlying ops, which all
  // surface their own errors as rejections.
  async writeFile(
    path: string,
    content: WriteFileContent,
    options: WriteFileOptions = {},
  ): Promise<void> {
    this.#checkWrite(path);
    await this.#inner.writeFile(path, content, options);
  }

  async mkdir(path: string, options: MkdirOptions = {}): Promise<void> {
    this.#checkWrite(path);
    await this.#inner.mkdir(path, options);
  }

  async rm(path: string, options: RmOptions = {}): Promise<void> {
    this.#checkWrite(path);
    await this.#inner.rm(path, options);
  }
}
