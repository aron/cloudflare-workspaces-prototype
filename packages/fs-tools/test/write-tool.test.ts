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
});
