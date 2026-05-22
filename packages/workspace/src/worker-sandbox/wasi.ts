/**
 * WASI preview-1 shim for running CLI WASM binaries in a Worker.
 *
 * Supports stdin, stdout/stderr (binary), and a small read/write filesystem
 * preopened at /workspace. Input files are supplied via the `files` map and
 * appear under /workspace/<name>. Output files are anything the program
 * creates or writes to under /workspace/<name> — collected and surfaced via
 * the `files` field of the result.
 *
 * Captures: stdout (bytes), stderr (bytes), exit code, written files.
 */

export interface WasiResult {
  stdout: Uint8Array;
  stderr: Uint8Array;
  exitCode: number;
  files: Record<string, Uint8Array>;  // /workspace/<name> → contents (only those created or modified)
}

export interface WasiOptions {
  args:  string[];                       // argv[0] is the binary name
  stdin?: Uint8Array;
  files?: Record<string, Uint8Array>;    // pre-populated readable files at /workspace/<name>
}

class WasiExit {
  constructor(public readonly code: number) {}
}

// errno values used here
const ERRNO_SUCCESS = 0;
const ERRNO_BADF    = 8;
const ERRNO_INVAL   = 28;
const ERRNO_NOENT   = 44;
const ERRNO_NOSYS   = 52;

// filetype
const FILETYPE_CHARACTER_DEVICE = 2;
const FILETYPE_DIRECTORY        = 3;
const FILETYPE_REGULAR_FILE     = 4;

// oflags
const OFLAGS_CREAT  = 1 << 0;
const OFLAGS_TRUNC  = 1 << 3;

// fdflags  (we only honor APPEND below)
const FDFLAGS_APPEND = 1 << 0;

// prestat tag
const PREOPENTYPE_DIR = 0;

// File entry inside our virtual /workspace
interface VFile {
  data: Uint8Array;  // logical content (may exceed buf length, see write)
  size: number;      // logical size
  dirty: boolean;    // written to since program start? (used to decide what to return)
}

// Open file descriptor
interface FD {
  type: "stdin" | "stdout" | "stderr" | "dir" | "file";
  path?: string;     // for dir / file
  pos:   number;
  append: boolean;
}

export async function runWasi(
  wasm: Uint8Array | WebAssembly.Module,
  opts: WasiOptions,
): Promise<WasiResult> {
  const { args } = opts;
  const stdinBytes = opts.stdin ?? new Uint8Array(0);

  // ---- virtual filesystem ----
  // /workspace is the single preopen, fd 3.
  const PREOPEN_PATH = "/workspace";
  const vfs = new Map<string, VFile>();
  for (const [path, bytes] of Object.entries(opts.files ?? {})) {
    if (!path.startsWith(PREOPEN_PATH + "/")) continue;
    vfs.set(path, { data: bytes, size: bytes.length, dirty: false });
  }

  const fds = new Map<number, FD>();
  fds.set(0, { type: "stdin",  pos: 0, append: false });
  fds.set(1, { type: "stdout", pos: 0, append: false });
  fds.set(2, { type: "stderr", pos: 0, append: false });
  fds.set(3, { type: "dir",    pos: 0, append: false, path: PREOPEN_PATH });
  let nextFd = 4;

  // ---- output buffers ----
  const stdoutChunks: Uint8Array[] = [];
  const stderrChunks: Uint8Array[] = [];
  let   stdinPos = 0;

  // ---- WASM memory views (set after instantiation) ----
  let mem: WebAssembly.Memory;
  const view  = () => new DataView(mem.buffer);
  const bytes = () => new Uint8Array(mem.buffer);

  // ---- arg encoding (argv_get / argv_sizes_get) ----
  const enc = new TextEncoder();
  const argBufs     = args.map(a => enc.encode(a + "\0"));
  const argBufTotal = argBufs.reduce((n, b) => n + b.length, 0);

  // ---- helpers ----
  function readStr(ptr: number, len: number): string {
    return new TextDecoder().decode(bytes().slice(ptr, ptr + len));
  }

  // Normalize a path supplied via path_open / path_filestat_get / etc.
  //   - strip trailing NULs / whitespace (Zig sometimes appends a NUL)
  //   - collapse runs of slashes
  //   - reject `..` segments
  // Returns:
  //   { absolute: true,  path: "/foo/bar" } if the path started with `/`
  //   { absolute: false, path: "foo/bar"  } if it was relative
  //   null on `..`
  function normalizePath(raw: string): { absolute: boolean; path: string } | null {
    const trimmed = raw.replace(/[\x00\s]+$/u, "").replace(/\/{2,}/g, "/");
    const absolute = trimmed.startsWith("/");
    const path = absolute ? trimmed.replace(/^\/+/, "/").replace(/^\/+/, "") : trimmed;
    // Note: after the two replaces above, an absolute path becomes its body
    // *without* the leading slash; we record absoluteness in the flag.
    if (path.split("/").some(seg => seg === "..")) return null;
    return { absolute, path };
  }

  // Resolve a (dirfd, rel|abs) pair into a canonical vfs key string.
  function resolvePath(dir: FD, raw: string): string | null {
    const norm = normalizePath(raw);
    if (norm === null) return null;
    if (norm.absolute) return norm.path === "" ? "/" : "/" + norm.path;
    return norm.path === "" ? (dir.path ?? PREOPEN_PATH) : `${dir.path ?? PREOPEN_PATH}/${norm.path}`;
  }

  // Iterate iovec array; call cb with a *view* (no copy) of each chunk.
  function eachIov(iovs_ptr: number, iovs_len: number, cb: (chunk: Uint8Array) => void): number {
    const v = view();
    let total = 0;
    for (let i = 0; i < iovs_len; i++) {
      const base = v.getUint32(iovs_ptr + i * 8,     true);
      const len  = v.getUint32(iovs_ptr + i * 8 + 4, true);
      if (len > 0) cb(bytes().subarray(base, base + len));
      total += len;
    }
    return total;
  }

  function getFile(path: string): VFile {
    let f = vfs.get(path);
    if (!f) {
      f = { data: new Uint8Array(0), size: 0, dirty: true };
      vfs.set(path, f);
    }
    return f;
  }

  // Directories aren't stored explicitly; they exist implicitly as a prefix of
  // at least one file. The preopen `/workspace` always exists.
  function isDir(path: string): boolean {
    if (path === PREOPEN_PATH) return true;
    const prefix = path + "/";
    for (const key of vfs.keys()) if (key.startsWith(prefix)) return true;
    return false;
  }

  // List immediate children of `dirPath` as {name, kind}.
  function listDir(dirPath: string): Array<{ name: string; kind: "file" | "dir" }> {
    const prefix = dirPath === "/" ? "/" : dirPath + "/";
    const children = new Map<string, "file" | "dir">();
    for (const key of vfs.keys()) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      if (rest.length === 0) continue;
      const slash = rest.indexOf("/");
      if (slash < 0) children.set(rest, "file");
      else children.set(rest.slice(0, slash), "dir");
    }
    return [...children].map(([name, kind]) => ({ name, kind }));
  }

  function fileWrite(f: VFile, pos: number, chunk: Uint8Array) {
    const needed = pos + chunk.length;
    if (needed > f.data.length) {
      let cap = Math.max(f.data.length * 2, 64 * 1024);
      while (cap < needed) cap *= 2;
      const next = new Uint8Array(cap);
      next.set(f.data.subarray(0, f.size));
      f.data = next;
    }
    f.data.set(chunk, pos);
    if (needed > f.size) f.size = needed;
    f.dirty = true;
  }

  function fileRead(f: VFile, pos: number, dst: Uint8Array): number {
    if (pos >= f.size) return 0;
    const end = Math.min(f.size, pos + dst.length);
    const n   = end - pos;
    dst.set(f.data.subarray(pos, end));
    return n;
  }

  // ---- the WASI interface ----
  const wasi: WebAssembly.ModuleImports = {
    // ---- args ----
    args_sizes_get(argc_ptr: number, argv_buf_size_ptr: number): number {
      view().setUint32(argc_ptr,          args.length, true);
      view().setUint32(argv_buf_size_ptr, argBufTotal, true);
      return ERRNO_SUCCESS;
    },
    args_get(argv_ptr: number, argv_buf_ptr: number): number {
      const v = view();
      let buf = argv_buf_ptr;
      for (let i = 0; i < argBufs.length; i++) {
        v.setUint32(argv_ptr + i * 4, buf, true);
        bytes().set(argBufs[i], buf);
        buf += argBufs[i].length;
      }
      return ERRNO_SUCCESS;
    },

    // ---- environment (empty) ----
    environ_sizes_get(count_ptr: number, buf_size_ptr: number): number {
      view().setUint32(count_ptr,    0, true);
      view().setUint32(buf_size_ptr, 0, true);
      return ERRNO_SUCCESS;
    },
    environ_get(_environ: number, _environ_buf: number): number { return ERRNO_SUCCESS; },

    // ---- clock ----
    clock_time_get(_id: number, _precision: bigint, time_ptr: number): number {
      view().setBigUint64(time_ptr, BigInt(Date.now()) * 1_000_000n, true);
      return ERRNO_SUCCESS;
    },

    // ---- random ----
    random_get(buf_ptr: number, buf_len: number): number {
      crypto.getRandomValues(bytes().subarray(buf_ptr, buf_ptr + buf_len));
      return ERRNO_SUCCESS;
    },

    // ---- proc_exit ----
    proc_exit(code: number): never { throw new WasiExit(code); },

    // ---- preopens ----
    // fd_prestat_get(fd, prestat_ptr) — always succeed for our single preopen
    // (fd 3), BADF for everything else. Spec: programs may call this multiple
    // times while resolving preopens, so we must NOT make it one-shot.
    fd_prestat_get(fd: number, prestat_ptr: number): number {
      if (fd !== 3) return ERRNO_BADF;
      const v = view();
      v.setUint8(prestat_ptr, PREOPENTYPE_DIR);
      v.setUint32(prestat_ptr + 4, PREOPEN_PATH.length, true);
      return ERRNO_SUCCESS;
    },
    fd_prestat_dir_name(fd: number, path_ptr: number, _path_len: number): number {
      if (fd !== 3) return ERRNO_BADF;
      bytes().set(enc.encode(PREOPEN_PATH), path_ptr);
      return ERRNO_SUCCESS;
    },

    // ---- fd ops ----
    fd_close(fd: number): number {
      if (fd <= 3) return ERRNO_SUCCESS;
      fds.delete(fd);
      return ERRNO_SUCCESS;
    },

    fd_fdstat_get(fd: number, stat_ptr: number): number {
      const f = fds.get(fd);
      if (!f) return ERRNO_BADF;
      const v = view();
      const type = f.type === "stdin" || f.type === "stdout" || f.type === "stderr"
        ? FILETYPE_CHARACTER_DEVICE
        : f.type === "dir"  ? FILETYPE_DIRECTORY
                            : FILETYPE_REGULAR_FILE;
      v.setUint8(stat_ptr, type);
      v.setUint8(stat_ptr + 1, 0);
      v.setBigUint64(stat_ptr + 8,  BigInt("0xffffffffffffffff"), true);
      v.setBigUint64(stat_ptr + 16, BigInt("0xffffffffffffffff"), true);
      return ERRNO_SUCCESS;
    },

    fd_fdstat_set_flags(_fd: number, _flags: number): number { return ERRNO_SUCCESS; },

    fd_filestat_get(fd: number, stat_ptr: number): number {
      const f = fds.get(fd);
      if (!f) return ERRNO_BADF;
      const v = view();
      let type = FILETYPE_REGULAR_FILE;
      let size = 0n;
      if (f.type === "file" && f.path) {
        const vf = vfs.get(f.path);
        if (!vf) return ERRNO_NOENT;
        size = BigInt(vf.size);
      } else if (f.type === "dir") {
        type = FILETYPE_DIRECTORY;
      } else {
        type = FILETYPE_CHARACTER_DEVICE;
      }
      // dev=0, ino=0, filetype, nlink=1, size, atim/mtim/ctim=0
      v.setBigUint64(stat_ptr,      0n,  true);
      v.setBigUint64(stat_ptr + 8,  0n,  true);
      v.setUint8(stat_ptr + 16, type);
      v.setBigUint64(stat_ptr + 24, 1n,  true);
      v.setBigUint64(stat_ptr + 32, size, true);
      v.setBigUint64(stat_ptr + 40, 0n,  true);
      v.setBigUint64(stat_ptr + 48, 0n,  true);
      v.setBigUint64(stat_ptr + 56, 0n,  true);
      return ERRNO_SUCCESS;
    },

    fd_read(fd: number, iovs_ptr: number, iovs_len: number, nread_ptr: number): number {
      const f = fds.get(fd);
      if (!f) return ERRNO_BADF;
      let total = 0;
      if (f.type === "stdin") {
        eachIov(iovs_ptr, iovs_len, dst => {
          const chunk = stdinBytes.subarray(stdinPos, stdinPos + dst.length);
          dst.set(chunk);
          stdinPos += chunk.length;
          total    += chunk.length;
        });
      } else if (f.type === "file" && f.path) {
        const vf = vfs.get(f.path);
        if (!vf) return ERRNO_NOENT;
        eachIov(iovs_ptr, iovs_len, dst => {
          const n = fileRead(vf, f.pos, dst);
          f.pos += n;
          total += n;
        });
      } else {
        return ERRNO_BADF;
      }
      view().setUint32(nread_ptr, total, true);
      return ERRNO_SUCCESS;
    },

    fd_write(fd: number, iovs_ptr: number, iovs_len: number, nwritten_ptr: number): number {
      const f = fds.get(fd);
      if (!f) return ERRNO_BADF;
      if (f.type === "stdout") {
        const n = eachIov(iovs_ptr, iovs_len, c => stdoutChunks.push(new Uint8Array(c)));
        view().setUint32(nwritten_ptr, n, true);
        return ERRNO_SUCCESS;
      }
      if (f.type === "stderr") {
        const n = eachIov(iovs_ptr, iovs_len, c => stderrChunks.push(new Uint8Array(c)));
        view().setUint32(nwritten_ptr, n, true);
        return ERRNO_SUCCESS;
      }
      if (f.type === "file" && f.path) {
        const vf = getFile(f.path);
        const pos0 = f.append ? vf.size : f.pos;
        let pos = pos0;
        eachIov(iovs_ptr, iovs_len, src => {
          fileWrite(vf, pos, src);
          pos += src.length;
        });
        if (!f.append) f.pos = pos;
        view().setUint32(nwritten_ptr, pos - pos0, true);
        return ERRNO_SUCCESS;
      }
      return ERRNO_BADF;
    },

    fd_seek(fd: number, offset: bigint, whence: number, newoffset_ptr: number): number {
      const f = fds.get(fd);
      if (!f || f.type !== "file" || !f.path) return ERRNO_BADF;
      const vf = vfs.get(f.path);
      if (!vf) return ERRNO_NOENT;
      // For our sizes 53 bits of JS Number is plenty.
      const off = Number(offset);
      let pos: number;
      if      (whence === 0) pos = off;                // SET
      else if (whence === 1) pos = f.pos + off;        // CUR
      else if (whence === 2) pos = vf.size + off;      // END
      else return ERRNO_INVAL;
      if (pos < 0) return ERRNO_INVAL;
      f.pos = pos;
      view().setBigUint64(newoffset_ptr, BigInt(pos), true);
      return ERRNO_SUCCESS;
    },

    // ---- path ops ----
    // We treat any dirfd that is a directory as "/workspace" (we only have one
    // preopen). We resolve `path` relative to that.
    path_open(
      dirfd: number,
      _dirflags: number,
      path_ptr: number, path_len: number,
      oflags: number,
      _fs_rights_base: bigint,
      _fs_rights_inheriting: bigint,
      fdflags: number,
      fd_ptr: number,
    ): number {
      const dir = fds.get(dirfd);
      if (!dir || dir.type !== "dir") return ERRNO_BADF;
      const abs = resolvePath(dir, readStr(path_ptr, path_len));
      if (abs === null) return ERRNO_INVAL;

      // Open as a directory if the target is one (preopen itself or any path
      // that has at least one file under it).
      if (isDir(abs)) {
        const fd = nextFd++;
        fds.set(fd, { type: "dir", path: abs, pos: 0, append: false });
        view().setUint32(fd_ptr, fd, true);
        return ERRNO_SUCCESS;
      }

      const exists = vfs.has(abs);
      if (!exists && !(oflags & OFLAGS_CREAT)) return ERRNO_NOENT;
      if (!exists || (oflags & OFLAGS_TRUNC)) {
        vfs.set(abs, { data: new Uint8Array(0), size: 0, dirty: true });
      }
      const fd = nextFd++;
      fds.set(fd, { type: "file", path: abs, pos: 0, append: !!(fdflags & FDFLAGS_APPEND) });
      view().setUint32(fd_ptr, fd, true);
      return ERRNO_SUCCESS;
    },

    path_filestat_get(
      dirfd: number, _flags: number,
      path_ptr: number, path_len: number,
      stat_ptr: number,
    ): number {
      const dir = fds.get(dirfd);
      if (!dir || dir.type !== "dir") return ERRNO_BADF;
      const abs = resolvePath(dir, readStr(path_ptr, path_len));
      if (abs === null) return ERRNO_INVAL;
      const vf  = vfs.get(abs);
      const dirHit = !vf && isDir(abs);
      if (!vf && !dirHit) return ERRNO_NOENT;
      const v = view();
      v.setBigUint64(stat_ptr,      0n, true);
      v.setBigUint64(stat_ptr + 8,  0n, true);
      v.setUint8(stat_ptr + 16, dirHit ? FILETYPE_DIRECTORY : FILETYPE_REGULAR_FILE);
      v.setBigUint64(stat_ptr + 24, 1n, true);
      v.setBigUint64(stat_ptr + 32, BigInt(vf?.size ?? 0), true);
      v.setBigUint64(stat_ptr + 40, 0n, true);
      v.setBigUint64(stat_ptr + 48, 0n, true);
      v.setBigUint64(stat_ptr + 56, 0n, true);
      return ERRNO_SUCCESS;
    },

    path_unlink_file(dirfd: number, path_ptr: number, path_len: number): number {
      const dir = fds.get(dirfd);
      if (!dir || dir.type !== "dir") return ERRNO_BADF;
      const abs = resolvePath(dir, readStr(path_ptr, path_len));
      if (abs === null) return ERRNO_INVAL;
      if (!vfs.has(abs)) return ERRNO_NOENT;
      vfs.delete(abs);
      return ERRNO_SUCCESS;
    },

    // Everything else: not implemented.
    path_create_directory(): number { return ERRNO_NOSYS; },
    path_remove_directory(): number { return ERRNO_NOSYS; },
    path_rename():           number { return ERRNO_NOSYS; },
    path_readlink():         number { return ERRNO_NOSYS; },
    path_symlink():          number { return ERRNO_NOSYS; },
    path_link():             number { return ERRNO_NOSYS; },
    fd_readdir(fd: number, buf_ptr: number, buf_len: number, cookie: bigint, bufused_ptr: number): number {
      const f = fds.get(fd);
      if (!f || f.type !== "dir" || !f.path) return ERRNO_BADF;
      const entries = listDir(f.path);
      const startCookie = Number(cookie);
      const v = view();
      const mem = bytes();
      let written = 0;
      for (let i = startCookie; i < entries.length; i++) {
        const entry = entries[i];
        const nameBytes = enc.encode(entry.name);
        const recordLen = 24 + nameBytes.length;
        if (written + recordLen > buf_len) {
          // Partial fit: write what we can so libc/Zig knows the buffer ran out.
          const remaining = buf_len - written;
          if (remaining > 0) mem.fill(0, buf_ptr + written, buf_ptr + buf_len);
          written = buf_len;
          break;
        }
        v.setBigUint64(buf_ptr + written +  0, BigInt(i + 1), true);   // d_next
        v.setBigUint64(buf_ptr + written +  8, 0n, true);              // d_ino
        v.setUint32   (buf_ptr + written + 16, nameBytes.length, true); // d_namlen
        v.setUint8    (buf_ptr + written + 20,
                       entry.kind === "dir" ? FILETYPE_DIRECTORY : FILETYPE_REGULAR_FILE);
        mem.set(nameBytes, buf_ptr + written + 24);
        written += recordLen;
      }
      v.setUint32(bufused_ptr, written, true);
      return ERRNO_SUCCESS;
    },
    fd_advise():             number { return ERRNO_SUCCESS; },
    fd_allocate():           number { return ERRNO_NOSYS; },
    fd_datasync():           number { return ERRNO_SUCCESS; },
    fd_sync():               number { return ERRNO_SUCCESS; },
    poll_oneoff():           number { return ERRNO_NOSYS; },
    sched_yield():           number { return ERRNO_SUCCESS; },
  };

  // ---- instantiate + run ----
  let instance: WebAssembly.Instance;
  if (wasm instanceof WebAssembly.Module) {
    instance = await WebAssembly.instantiate(wasm, { wasi_snapshot_preview1: wasi });
  } else {
    const result = await WebAssembly.instantiate(wasm, { wasi_snapshot_preview1: wasi });
    instance = (result as any).instance ?? result;
  }
  mem = instance.exports.memory as WebAssembly.Memory;

  let exitCode = 0;
  try {
    const start = instance.exports._start as (() => void) | undefined;
    if (!start) throw new Error("WASM module has no _start export");
    start();
  } catch (e) {
    if (e instanceof WasiExit) exitCode = e.code;
    else {
      const msg = (e as Error).stack ?? String(e);
      stderrChunks.push(new TextEncoder().encode(`\n[runner trap] ${msg}\n`));
      exitCode = 1;
    }
  }

  // Collect dirty files (created or written during this run)
  const outFiles: Record<string, Uint8Array> = {};
  for (const [path, vf] of vfs) {
    if (vf.dirty) outFiles[path] = vf.data.subarray(0, vf.size);
  }

  return {
    stdout:   concat(stdoutChunks),
    stderr:   concat(stderrChunks),
    exitCode,
    files:    outFiles,
  };
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}
