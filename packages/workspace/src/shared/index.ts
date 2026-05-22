/**
 * Wire types and the RPC interface shared between the DO-side `Workspace`
 * class and the container-side server.
 */

export interface VfsEntry {
  path:    string;
  type:    "file" | "dir";
  mode:    number;
  mtime:   number;
  content?: ReadableStream<Uint8Array>;
}

export interface VfsChange {
  seq:    number;
  path:   string;
  op:     "upsert" | "delete";
  type?:  "file" | "dir";
  mode?:  number;
  mtime?: number;
  content?: ReadableStream<Uint8Array>;
}

export interface FileStat {
  type:  "file" | "dir";
  mode:  number;
  mtime: number;
  size:  number;
}

export interface GrepHit {
  path: string;
  line: number;
  text: string;
}

export interface ExecResult {
  exitCode: number;
  stdout:   string;
  stderr:   string;
  pushed:   number;  // # of changes uploaded to the container before the command
  pulled:   number;  // # of changes downloaded after the command
}

export interface ExecOptions {
  cwd?: string;
}

/**
 * The RPC surface the container server exposes over capnweb.
 * Both sides must agree on this shape exactly.
 */
export interface ContainerRpc {
  snapshot():                                        Promise<{ entries: VfsEntry[]; seq: number }>;
  applyChanges(changes: VfsChange[]):                Promise<{ seq: number }>;
  getDirtyNodes(since?: number):                     Promise<VfsChange[]>;
  exec(command: string, cwd?: string):               Promise<{ exitCode: number; stdout: string; stderr: string }>;
}
