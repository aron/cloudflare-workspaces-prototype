import { createWorkspaceError } from "./errors.js";
import { canonicalizePath } from "./path.js";
import { initializeSchema } from "./schema.js";
import { Database } from "./storage.js";
import type {
  DurableObjectStorageLike,
  WorkspaceDirent,
  WorkspaceFilesystem,
  WorkspaceFilesystemOptions,
  WorkspaceFoundEntry,
  WorkspaceGrepMatch,
  WorkspaceStat,
} from "./types.js";

function notImplemented(method: string): never {
  throw createWorkspaceError("EIO", `${method} is not implemented yet`);
}

export class SqliteWorkspaceFilesystem implements WorkspaceFilesystem {
  private readonly db: Database;
  private readonly now: () => number;
  private initialized = false;

  constructor(storage: DurableObjectStorageLike, options: WorkspaceFilesystemOptions = {}) {
    this.db = new Database(storage);
    this.now = options.now ?? Date.now;
  }

  readFile(path: string): Promise<ReadableStream<Uint8Array>>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  readFile(path: string, options: { encoding?: "utf8" }): Promise<string>;
  async readFile(
    path: string,
    _options?: "utf8" | { encoding?: "utf8" },
  ): Promise<ReadableStream<Uint8Array> | string> {
    this.ensureInitialized();
    canonicalizePath(path);
    notImplemented("readFile");
  }

  async writeFile(
    path: string,
    _content: string | Uint8Array | ReadableStream<Uint8Array>,
    _options?: { mode?: number },
  ): Promise<void> {
    this.ensureInitialized();
    canonicalizePath(path);
    notImplemented("writeFile");
  }

  async rm(path: string, _options?: { recursive?: true; force?: true }): Promise<void> {
    this.ensureInitialized();
    canonicalizePath(path);
    notImplemented("rm");
  }

  async mkdir(path: string, _options?: { recursive?: true; mode?: number }): Promise<void> {
    this.ensureInitialized();
    canonicalizePath(path);
    notImplemented("mkdir");
  }

  async readdir(path: string): Promise<WorkspaceDirent[]> {
    this.ensureInitialized();
    canonicalizePath(path);
    notImplemented("readdir");
  }

  async stat(path: string): Promise<WorkspaceStat> {
    this.ensureInitialized();
    canonicalizePath(path);
    notImplemented("stat");
  }

  async find(directory: string, _pattern?: string): Promise<WorkspaceFoundEntry[]> {
    this.ensureInitialized();
    canonicalizePath(directory);
    notImplemented("find");
  }

  async ls(prefix: string): Promise<string[]> {
    this.ensureInitialized();
    canonicalizePath(prefix);
    notImplemented("ls");
  }

  async grep(
    _pattern: string,
    path: string,
    _options?: { ignoreCase?: boolean },
  ): Promise<WorkspaceGrepMatch[]> {
    this.ensureInitialized();
    canonicalizePath(path);
    notImplemented("grep");
  }

  private ensureInitialized(): void {
    if (this.initialized) {
      return;
    }

    initializeSchema(this.db, this.now);
    this.initialized = true;
  }
}
