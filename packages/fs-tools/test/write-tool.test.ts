import { describe, expect, it } from "vitest";
import { InMemoryFileStore } from "../src/stores/in-memory.js";
import { createWriteTool } from "../src/tools/write.js";

const dec = new TextDecoder();

async function exec(tool: any, input: any) {
  // ai-sdk tools expose .execute on the returned object.
  return tool.execute(input, { toolCallId: "t1", messages: [] });
}

describe("createWriteTool", () => {
  it("writes the content and returns the byte count", async () => {
    const store = new InMemoryFileStore();
    const tool = createWriteTool({ store });
    const result = await exec(tool, { path: "/a.txt", content: "hello" });
    expect(result).toEqual({ path: "/a.txt", bytesWritten: 5 });
    const buf = await store.readAll("/a.txt");
    expect(buf && dec.decode(buf)).toBe("hello");
  });

  it("counts bytes, not characters, for multi-byte content", async () => {
    const store = new InMemoryFileStore();
    const tool = createWriteTool({ store });
    const result = await exec(tool, { path: "/u.txt", content: "héllo" }); // é = 2 bytes utf-8
    expect(result.bytesWritten).toBe(6);
  });

  it("overwrites existing files", async () => {
    const store = new InMemoryFileStore();
    const tool = createWriteTool({ store });
    await exec(tool, { path: "/a", content: "first" });
    await exec(tool, { path: "/a", content: "second" });
    const buf = await store.readAll("/a");
    expect(buf && dec.decode(buf)).toBe("second");
  });

  it("rejects writes larger than maxBytes with an actionable hint", async () => {
    const store = new InMemoryFileStore();
    const tool = createWriteTool({ store, maxBytes: 4 });
    const result = await exec(tool, { path: "/big", content: "12345" });
    expect(result).toMatchObject({ error: expect.stringMatching(/too large/i) });
    expect(result.error).toMatch(/edit/); // points the model at the edit tool
    expect(await store.stat("/big")).toBeNull(); // file not created
  });

  it("preserves the existing file's mode when overwriting", async () => {
    // Regression: write used to drop mode bits on overwrite, silently
    // turning executable scripts into plain files (0o100755 → 0o100644).
    const store = new InMemoryFileStore();
    await store.write("/run.sh", new TextEncoder().encode("old"), { mode: 0o100755 });
    const tool = createWriteTool({ store });
    await exec(tool, { path: "/run.sh", content: "new" });
    expect((await store.stat("/run.sh"))?.mode).toBe(0o100755);
  });

  it("creates new files with the store's default mode", async () => {
    // No prior file means no mode to preserve — the store applies its own
    // regular-file default rather than inheriting some unrelated file's mode.
    const store = new InMemoryFileStore();
    const tool = createWriteTool({ store });
    await exec(tool, { path: "/new.txt", content: "hi" });
    expect((await store.stat("/new.txt"))?.mode).toBe(0o100644);
  });
});
