// WorkspaceFilesystem — class wrapper that binds a Database and a
// clock to the free fs/* functions, exposing the surface documented
// in docs/04_filesystem_interface.md.
//
// Every method here is a thin forward to the matching free
// function. The class exists so callers (host-side Workspace,
// in-container tools, tests) get a single instance to thread
// through their code rather than passing (db, now) pairs into
// every call.
//
// Free functions stay exported for callers that prefer the
// stateless form — e.g. one-off ops in tests, or apply paths in
// sync/* that operate on a Database directly.

import type { Database } from "../storage.js";

import { find, type WorkspaceFoundEntry } from "./find.js";
import { type GrepOptions, grep, type WorkspaceGrepMatch } from "./grep.js";
import { ls } from "./ls.js";
import { type MkdirOptions, mkdir } from "./mkdir.js";
import { readdir, type WorkspaceDirentResult } from "./readdir.js";
import { type ReadFileOptions, readFile } from "./readFile.js";
import { type RmOptions, rm } from "./rm.js";
import { stat, type WorkspaceStatResult } from "./stat.js";
import { type WriteFileContent, type WriteFileOptions, writeFile } from "./writeFile.js";

export interface WorkspaceFilesystemOptions {
  // Clock used for mtime / last_seen. Defaults to Date.now.
  // Override for deterministic tests.
  now?: () => number;
}

export class WorkspaceFilesystem {
  readonly db: Database;
  readonly now: () => number;

  constructor(db: Database, options: WorkspaceFilesystemOptions = {}) {
    this.db = db;
    this.now = options.now ?? Date.now;
  }

  // --- Reads -------------------------------------------------------

  readFile(path: string): Promise<ReadableStream<Uint8Array>>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  readFile(path: string, options: ReadFileOptions): Promise<string | ReadableStream<Uint8Array>>;
  readFile(
    path: string,
    optionsOrEncoding?: "utf8" | ReadFileOptions,
  ): Promise<string | ReadableStream<Uint8Array>> {
    // Forward through the free function's overload set. The
    // individual overloads above let callers see the precise
    // return type for each input shape.
    // Cast through the union overload of the free function;
    // the class's overloads above carry the precise return type
    // for each input shape back to the caller.
    return readFile(this.db, path, optionsOrEncoding as ReadFileOptions, this.now);
  }

  async stat(path: string): Promise<WorkspaceStatResult> {
    return stat(this.db, path);
  }

  async readdir(path: string): Promise<WorkspaceDirentResult[]> {
    return readdir(this.db, path);
  }

  async find(directory: string, pattern?: string): Promise<WorkspaceFoundEntry[]> {
    return find(this.db, directory, pattern);
  }

  async ls(prefix: string): Promise<string[]> {
    return ls(this.db, prefix);
  }

  grep(pattern: string, path: string, options: GrepOptions = {}): Promise<WorkspaceGrepMatch[]> {
    return grep(this.db, pattern, path, options);
  }

  // --- Mutations ---------------------------------------------------

  writeFile(
    path: string,
    content: WriteFileContent,
    options: WriteFileOptions = {},
  ): Promise<void> {
    return writeFile(this.db, path, content, options, this.now);
  }

  async mkdir(path: string, options: MkdirOptions = {}): Promise<void> {
    mkdir(this.db, path, options, this.now);
  }

  async rm(path: string, options: RmOptions = {}): Promise<void> {
    rm(this.db, path, options);
  }
}
