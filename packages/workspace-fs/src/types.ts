export interface SqlCursorLike<Row extends object = Record<string, unknown>> {
  toArray(): Row[];
}

export interface SqlStorageLike {
  exec<Row extends object = Record<string, unknown>>(
    query: string,
    ...bindings: unknown[]
  ): SqlCursorLike<Row>;
}

export interface DurableObjectStorageLike {
  sql: SqlStorageLike;
  transaction?<T>(closure: () => T | Promise<T>): T | Promise<T>;
  transactionSync?<T>(closure: () => T): T;
}

export interface WorkspaceFilesystemOptions {
  now?: () => number;
}

export interface WorkspaceDirent {
  name: string;
  parentPath: string;
  isFile: boolean;
  isDirectory: boolean;
}

export interface WorkspaceStat {
  name: string;
  mode: number;
  mtime: number;
  size: number;
  isFile: boolean;
  isDirectory: boolean;
}

export interface WorkspaceFoundEntry {
  path: string;
  type: "file" | "dir";
}

export interface WorkspaceGrepMatch {
  path: string;
  line: number;
  text: string;
}

export interface WorkspaceFilesystem {
  readFile(path: string): Promise<ReadableStream<Uint8Array>>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  readFile(path: string, options: { encoding?: "utf8" }): Promise<string>;

  writeFile(
    path: string,
    content: string | Uint8Array | ReadableStream<Uint8Array>,
    options?: { mode?: number },
  ): Promise<void>;

  rm(path: string, options?: { recursive?: true; force?: true }): Promise<void>;
  mkdir(path: string, options?: { recursive?: true; mode?: number }): Promise<void>;

  readdir(path: string): Promise<WorkspaceDirent[]>;
  stat(path: string): Promise<WorkspaceStat>;
  find(directory: string, pattern?: string): Promise<WorkspaceFoundEntry[]>;
  ls(prefix: string): Promise<string[]>;
  grep(
    pattern: string,
    path: string,
    options?: { ignoreCase?: boolean },
  ): Promise<WorkspaceGrepMatch[]>;
}
