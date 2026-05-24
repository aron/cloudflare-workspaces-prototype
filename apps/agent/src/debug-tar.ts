/**
 * Minimal POSIX ustar writer used by the agent's `/tar` debug endpoint.
 *
 * The tar format is just a sequence of 512-byte records. Each file is a
 * 512-byte header followed by its content rounded up to a 512-byte
 * boundary; the stream ends with two zero records. We support the
 * regular-file (typeflag '0') and directory (typeflag '5') record types
 * — that's enough for a session snapshot.
 *
 * Output is uncompressed (.tar). Compression would force us to buffer
 * the whole archive or pull in a deflate library; the savings on a
 * mostly-JSON-plus-source-files payload aren't worth it.
 */

import type { Workspace } from "@cloudflare/workspace";

const BLOCK = 512;

interface TarEntry {
  /** Path inside the archive (no leading slash, ≤ 100 bytes). */
  name: string;
  /** Unix mtime in seconds. */
  mtime: number;
  /** `"0"` for regular file, `"5"` for directory. */
  typeflag: "0" | "5";
  /** File content; ignored for directories. */
  content?: Uint8Array;
}

const enc = new TextEncoder();

function writeString(buf: Uint8Array, off: number, s: string, len: number): void {
  const bytes = enc.encode(s);
  buf.set(bytes.subarray(0, Math.min(bytes.length, len)), off);
}

function writeOctal(buf: Uint8Array, off: number, n: number, len: number): void {
  // ustar fields are zero-padded octal, NUL-terminated within `len` bytes.
  const s = n.toString(8).padStart(len - 1, "0");
  writeString(buf, off, s, len - 1);
  // The final byte is already zero from the Uint8Array initializer.
}

function buildHeader(entry: TarEntry, size: number): Uint8Array {
  const h = new Uint8Array(BLOCK);
  writeString(h, 0,   entry.name, 100);     // name
  writeOctal (h, 100, 0o644,         8);    // mode
  writeOctal (h, 108, 0,             8);    // uid
  writeOctal (h, 116, 0,             8);    // gid
  writeOctal (h, 124, size,         12);    // size
  writeOctal (h, 136, entry.mtime,  12);    // mtime
  // checksum field is spaces during computation, then overwritten below
  for (let i = 148; i < 156; i++) h[i] = 0x20;
  writeString(h, 156, entry.typeflag, 1);   // typeflag
  // linkname (157..256) left zero
  writeString(h, 257, "ustar",       6);    // magic
  writeString(h, 263, "00",          2);    // version
  // uname (265..297), gname (297..329), devmajor/minor, prefix left zero

  // Checksum is the unsigned sum of all header bytes, octal, 6 digits + NUL + space.
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += h[i]!;
  writeOctal(h, 148, sum, 7);                // 6 digits + NUL at offset 154
  h[155] = 0x20;                             // trailing space per spec

  return h;
}

/** Build a complete tar archive in memory. */
export function buildTar(entries: TarEntry[]): Uint8Array {
  let total = 0;
  for (const e of entries) {
    const size = e.typeflag === "0" ? (e.content?.length ?? 0) : 0;
    total += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
  }
  total += BLOCK * 2; // end-of-archive marker

  const out = new Uint8Array(total);
  let off = 0;
  for (const e of entries) {
    const content = e.typeflag === "0" ? (e.content ?? new Uint8Array(0)) : new Uint8Array(0);
    out.set(buildHeader(e, content.length), off);
    off += BLOCK;
    if (content.length > 0) {
      out.set(content, off);
      off += Math.ceil(content.length / BLOCK) * BLOCK;
    }
  }
  // Last 1024 bytes are already zero.
  return out;
}

// ---------------------------------------------------------------------------

export interface SessionTarInputs {
  agentName:  string;
  /** Anything JSON-serializable; written to `metadata.json`. */
  metadata:   Record<string, unknown>;
  /** Full chat history; written to `messages.json` as pretty JSON. */
  messages:   unknown;
  /** The agent's `Workspace` — VFS contents go under `vfs/`. */
  workspace?: Workspace;
}

/**
 * Snapshot the agent's session state as a tar archive. Layout:
 *
 *   <agentName>/metadata.json     — pointer info (room, thread, model, time)
 *   <agentName>/messages.json     — full chat history
 *   <agentName>/vfs-index.json    — file listing with sizes and mtimes
 *   <agentName>/vfs/<path>        — file contents, one entry per VFS file
 */
export async function buildSessionTar(inputs: SessionTarInputs): Promise<Uint8Array> {
  const { agentName, metadata, messages, workspace } = inputs;
  const now = Math.floor(Date.now() / 1000);

  const entries: TarEntry[] = [
    { name: `${agentName}/`,                 mtime: now, typeflag: "5" },
    { name: `${agentName}/metadata.json`,    mtime: now, typeflag: "0",
      content: enc.encode(JSON.stringify(metadata, null, 2) + "\n") },
    { name: `${agentName}/messages.json`,    mtime: now, typeflag: "0",
      content: enc.encode(JSON.stringify(messages, null, 2) + "\n") },
  ];

  if (workspace) {
    // Best-effort VFS snapshot. The snapshot iterator returns streams; we
    // drain each one so the tar writer can size and pad correctly.
    const snap = workspace.vfs.snapshot() as {
      entries: Array<{ path: string; type: "file" | "dir"; mtime: number; content?: ReadableStream<Uint8Array> }>;
    };
    const index: Array<{ path: string; type: string; size: number; mtime: number }> = [];
    const dirsSeen = new Set<string>();

    for (const e of snap.entries) {
      // Strip leading `/` so the archive root is `<agentName>/vfs/...`.
      const rel = e.path.replace(/^\/+/, "");
      if (!rel) continue;

      if (e.type === "dir") {
        const name = `${agentName}/vfs/${rel}/`;
        if (!dirsSeen.has(name)) {
          dirsSeen.add(name);
          entries.push({ name, mtime: e.mtime, typeflag: "5" });
        }
        index.push({ path: e.path, type: "dir", size: 0, mtime: e.mtime });
        continue;
      }

      const content = e.content ? await new Response(e.content).bytes() : new Uint8Array(0);
      entries.push({
        name:     `${agentName}/vfs/${rel}`,
        mtime:    e.mtime,
        typeflag: "0",
        content,
      });
      index.push({ path: e.path, type: "file", size: content.length, mtime: e.mtime });
    }

    entries.push({
      name:     `${agentName}/vfs-index.json`,
      mtime:    now,
      typeflag: "0",
      content:  enc.encode(JSON.stringify({ count: index.length, entries: index }, null, 2) + "\n"),
    });
  }

  return buildTar(entries);
}
