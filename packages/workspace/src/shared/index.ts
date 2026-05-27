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

/**
 * Lightweight VfsChange used by the bulk-pull transport: instead of
 * carrying a per-file `ReadableStream`, files reference a slice
 * (`contentOffset`, `contentSize`) of a single concatenated blob
 * shipped alongside.  Dropping the per-file stream is what wins the
 * round-trips inside capnweb.
 */
export interface VfsChangeLite {
  seq:    number;
  path:   string;
  op:     "upsert" | "delete";
  type?:  "file" | "dir";
  mode?:  number;
  mtime?: number;
  contentOffset?: number;  // byte offset into the bulk blob (files only)
  contentSize?:   number;  // byte length in the bulk blob (files only)
}

/**
 * Return shape of the bulk pull: one stream for the concatenated bytes
 * of every file in `changes`, in the order those files appear.  Empty
 * blob if there are no file upserts.
 */
export interface DirtyBulk {
  changes: VfsChangeLite[];
  blob:    ReadableStream<Uint8Array>;
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
  getDirtyNodes(since?: number, ignore?: string[]):  Promise<VfsChange[]>;
  /**
   * Bulk pull: lightweight metadata records plus a single byte stream
   * holding every file's content concatenated.  Cuts capnweb's
   * per-stream round-trips down to one stream total.
   */
  pullDirty(since?: number, ignore?: string[]):      Promise<DirtyBulk>;
  exec(command: string, cwd?: string):               Promise<{ exitCode: number; stdout: string; stderr: string }>;
}
