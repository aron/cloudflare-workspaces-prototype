/**
 * Abstract filesystem boundary used by every fs-tool.
 *
 * Implementations are expected to be cheap to construct and safe to share
 * across concurrent tool invocations. Streaming methods MUST NOT load the
 * full file into memory at any single point — that is the whole reason the
 * boundary exists.
 */
export interface FileStat {
  /** Size in bytes. */
  size: number;
  /** Last-modified epoch milliseconds. */
  mtime: number;
  /**
   * POSIX-style mode bits (e.g. 0o100644 for a regular file, 0o100755 for
   * an executable). Omitted by stores that don't track modes; tools should
   * fall through to their own default (regular file) in that case.
   */
  mode?: number;
}

export interface FileStore {
  /** Return file metadata, or null if the path does not exist or is not a file. */
  stat(path: string): Promise<FileStat | null>;

  /**
   * Stream the file (or a byte range of it) in chunks. The total bytes yielded
   * MUST equal min(byteLength ?? size - byteOffset, size - byteOffset).
   *
   * Throws if the path does not exist.
   */
  readChunks(
    path: string,
    byteOffset?: number,
    byteLength?: number,
  ): AsyncIterable<Uint8Array>;

  /**
   * Read the entire file into memory. Used for images and for the edit tool
   * where fuzzy matching needs the whole buffer. Returns null if missing.
   */
  readAll(path: string): Promise<Uint8Array | null>;

  /**
   * Overwrite (or create) a file with the given bytes.
   *
   * `opts.mode` lets the caller pin the resulting file's POSIX mode — used
   * by `edit` and `write` to preserve the executable bit across an
   * overwrite. Stores that don't track modes may ignore it; stores that
   * do must store the value verbatim (not OR/AND with the previous mode).
   */
  write(path: string, content: Uint8Array, opts?: { mode?: number }): Promise<void>;
}
