import { describe, expect, it, vi } from "vitest";
import { type WorkspaceLike, WorkspaceFileStore } from "../src/stores/workspace.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * In-memory fake that matches the `@cloudflare/workspace` Workspace surface
 * we depend on. Mirrors the real implementation's chunked storage so we can
 * verify that `readChunks` slices SQLite rows correctly without standing up
 * a Durable Object.
 */
function makeFakeWorkspace(chunkSize = 8): WorkspaceLike & { _files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();
  const stat: WorkspaceLike["stat"] = (path) => {
    const f = files.get(path);
    if (!f) return null;
    return { type: "file", size: f.length, mtime: 1 };
  };
  return {
    _files: files,
    stat,
    readFile(path) {
      return files.get(path) ?? null;
    },
    writeFile(path, content) {
      const bytes =
        typeof content === "string" ? new TextEncoder().encode(content) : new Uint8Array(content);
      files.set(path, bytes);
    },
    vfs: {
      *readChunks(path, byteOffset = 0, byteLength) {
        const f = files.get(path);
        if (!f) throw new Error(`File not found: ${path}`);
        const end = byteLength === undefined ? f.length : Math.min(f.length, byteOffset + byteLength);
        for (let i = byteOffset; i < end; i += chunkSize) {
          yield f.subarray(i, Math.min(end, i + chunkSize));
        }
      },
    },
  };
}

async function collect(iter: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let total = 0;
  for await (const c of iter) {
    parts.push(c);
    total += c.length;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

describe("WorkspaceFileStore", () => {
  it("delegates stat to the workspace", async () => {
    const ws = makeFakeWorkspace();
    ws.writeFile("/a", enc.encode("hello"));
    const store = new WorkspaceFileStore(ws);
    expect(await store.stat("/a")).toEqual({ size: 5, mtime: 1 });
  });

  it("returns null when stat reports a directory", async () => {
    const ws: WorkspaceLike = {
      stat: () => ({ type: "dir", size: 0, mtime: 1 }),
      readFile: () => null,
      writeFile: () => {},
    };
    const store = new WorkspaceFileStore(ws);
    expect(await store.stat("/d")).toBeNull();
  });

  it("readAll delegates to workspace.readFile", async () => {
    const ws = makeFakeWorkspace();
    ws.writeFile("/a", enc.encode("hello"));
    const store = new WorkspaceFileStore(ws);
    const buf = await store.readAll("/a");
    expect(buf && dec.decode(buf)).toBe("hello");
  });

  it("write delegates to workspace.writeFile with raw bytes", async () => {
    const ws = makeFakeWorkspace();
    const spy = vi.spyOn(ws, "writeFile");
    const store = new WorkspaceFileStore(ws);
    await store.write("/a", enc.encode("hi"));
    expect(spy).toHaveBeenCalledOnce();
    const [, content] = spy.mock.calls[0];
    expect(content).toBeInstanceOf(Uint8Array);
    expect(dec.decode(content as Uint8Array)).toBe("hi");
  });

  it("readChunks uses vfs.readChunks when present", async () => {
    const ws = makeFakeWorkspace(4);
    ws.writeFile("/a", enc.encode("abcdefghij"));
    const store = new WorkspaceFileStore(ws);
    const out = await collect(store.readChunks("/a", 2, 5));
    expect(dec.decode(out)).toBe("cdefg");
  });

  it("readChunks yields multiple chunks aligned to the underlying chunkSize", async () => {
    const ws = makeFakeWorkspace(4);
    ws.writeFile("/a", enc.encode("abcdefghij"));
    const store = new WorkspaceFileStore(ws);
    const chunks: Uint8Array[] = [];
    for await (const c of store.readChunks("/a")) chunks.push(c);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map(c => dec.decode(c)).join("")).toBe("abcdefghij");
  });

  it("falls back to readFile + slicing when vfs is not provided", async () => {
    const files = new Map<string, Uint8Array>();
    files.set("/a", enc.encode("abcdefghij"));
    const ws: WorkspaceLike = {
      stat: (p) => (files.has(p) ? { type: "file", size: files.get(p)!.length, mtime: 1 } : null),
      readFile: (p) => files.get(p) ?? null,
      writeFile: () => {},
      // no vfs
    };
    const store = new WorkspaceFileStore(ws);
    const out = await collect(store.readChunks("/a", 3, 4));
    expect(dec.decode(out)).toBe("defg");
  });

  it("readChunks throws for missing files", async () => {
    const ws = makeFakeWorkspace();
    const store = new WorkspaceFileStore(ws);
    await expect(collect(store.readChunks("/nope"))).rejects.toThrow(/not found/i);
  });

  it("plays through the read tool end-to-end", async () => {
    // Wire the adapter into the actual read tool to prove they compose.
    const { createReadTool } = await import("../src/tools/read.js");
    const ws = makeFakeWorkspace(4);
    const text = Array.from({ length: 10 }, (_, i) => `line-${i + 1}`).join("\n");
    ws.writeFile("/a.txt", enc.encode(text));
    const tool: any = createReadTool({ store: new WorkspaceFileStore(ws) });
    const out: any = await tool.execute(
      { path: "/a.txt", offset: 4, limit: 3 },
      { toolCallId: "t1", messages: [] },
    );
    expect(out.content).toBe("line-4\nline-5\nline-6");
  });
});
