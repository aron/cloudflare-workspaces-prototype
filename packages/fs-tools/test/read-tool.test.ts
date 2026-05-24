import { describe, expect, it } from "vitest";
import { InMemoryFileStore } from "../src/stores/in-memory.js";
import { createReadTool } from "../src/tools/read.js";

const enc = new TextEncoder();

async function exec(tool: any, input: any) {
  return tool.execute(input, { toolCallId: "t1", messages: [] });
}

function makeText(lines: number, prefix = "line"): string {
  return Array.from({ length: lines }, (_, i) => `${prefix}-${i + 1}`).join("\n");
}

describe("createReadTool", () => {
  it("returns the whole file when small enough", async () => {
    const store = new InMemoryFileStore();
    await store.write("/a.txt", enc.encode("hello\nworld"));
    const tool = createReadTool({ store });
    const out = await exec(tool, { path: "/a.txt" });
    expect(out.content).toBe("hello\nworld");
    expect(out.truncated).toBeFalsy();
  });

  it("returns an error for missing files", async () => {
    const store = new InMemoryFileStore();
    const tool = createReadTool({ store });
    const out = await exec(tool, { path: "/nope" });
    expect(out.error).toMatch(/not found/i);
  });

  it("honors offset (1-indexed lines)", async () => {
    const store = new InMemoryFileStore();
    await store.write("/a.txt", enc.encode(makeText(10)));
    const tool = createReadTool({ store });
    const out = await exec(tool, { path: "/a.txt", offset: 3 });
    expect(out.content.split("\n")[0]).toBe("line-3");
    expect(out.content.split("\n").length).toBe(8); // lines 3..10
  });

  it("honors limit", async () => {
    const store = new InMemoryFileStore();
    await store.write("/a.txt", enc.encode(makeText(10)));
    const tool = createReadTool({ store });
    const out = await exec(tool, { path: "/a.txt", offset: 2, limit: 3 });
    expect(out.content).toBe("line-2\nline-3\nline-4");
    expect(out.startLine).toBe(2);
    expect(out.endLine).toBe(4);
    expect(out.totalLines).toBeNull(); // streaming reader stops counting at the cap
    expect(out.truncated).toBe(true);
    expect(out.nextOffset).toBe(5);
  });

  it("returns an error when offset is past EOF", async () => {
    const store = new InMemoryFileStore();
    await store.write("/a.txt", enc.encode(makeText(5)));
    const tool = createReadTool({ store });
    const out = await exec(tool, { path: "/a.txt", offset: 99 });
    expect(out.error).toMatch(/beyond end of file/);
  });

  it("truncates at maxLines and reports a continuation offset", async () => {
    const store = new InMemoryFileStore();
    await store.write("/a.txt", enc.encode(makeText(50)));
    const tool = createReadTool({ store, maxLines: 10 });
    const out = await exec(tool, { path: "/a.txt" });
    expect(out.content.split("\n").length).toBe(10);
    expect(out.startLine).toBe(1);
    expect(out.endLine).toBe(10);
    expect(out.truncated).toBe(true);
    expect(out.nextOffset).toBe(11);
  });

  it("truncates at maxBytes when lines fit but bytes overflow", async () => {
    // 100 lines of "x".repeat(100) → 10_000 bytes total. Cap at 1024 should
    // stop after ~10 lines.
    const store = new InMemoryFileStore();
    const long = Array.from({ length: 100 }, () => "x".repeat(100)).join("\n");
    await store.write("/a.txt", enc.encode(long));
    const tool = createReadTool({ store, maxBytes: 1024, maxLines: 10_000 });
    const out = await exec(tool, { path: "/a.txt" });
    expect(out.truncated).toBe(true);
    expect(out.nextOffset).toBeGreaterThan(1);
    expect(out.endLine).toBeLessThan(100);
  });

  it("reports when the first line alone exceeds maxBytes", async () => {
    const store = new InMemoryFileStore();
    await store.write("/a.txt", enc.encode("x".repeat(5000) + "\nshort"));
    const tool = createReadTool({ store, maxBytes: 1024 });
    const out = await exec(tool, { path: "/a.txt" });
    expect(out.error).toMatch(/exceeds.*limit/i);
  });

  it("streams: doesn't pull chunks past the cap", async () => {
    // Use chunkSize 64 so we can count read attempts.
    const store = new InMemoryFileStore({ chunkSize: 64 });
    await store.write("/a.txt", enc.encode(makeText(10_000)));
    let chunksPulled = 0;
    const wrapped = {
      stat: (p: string) => store.stat(p),
      readAll: (p: string) => store.readAll(p),
      write: (p: string, c: Uint8Array) => store.write(p, c),
      async *readChunks(p: string, off?: number, len?: number) {
        for await (const c of store.readChunks(p, off, len)) {
          chunksPulled++;
          yield c;
        }
      },
    };
    const tool = createReadTool({ store: wrapped, maxLines: 5 });
    await exec(tool, { path: "/a.txt" });
    // 5 short lines fit in well under one 64-byte chunk; we should not have
    // streamed the whole 80 kB file.
    expect(chunksPulled).toBeLessThan(5);
  });

  it("handles offsets that fall mid-chunk in the underlying store", async () => {
    const store = new InMemoryFileStore({ chunkSize: 7 });
    await store.write("/a.txt", enc.encode(makeText(20)));
    const tool = createReadTool({ store });
    const out = await exec(tool, { path: "/a.txt", offset: 15, limit: 3 });
    expect(out.content).toBe("line-15\nline-16\nline-17");
  });
});
