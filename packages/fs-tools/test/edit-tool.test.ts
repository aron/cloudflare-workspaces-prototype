import { describe, expect, it } from "vitest";
import { InMemoryFileStore } from "../src/stores/in-memory.js";
import { createEditTool } from "../src/tools/edit.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

async function exec(tool: any, input: any) {
  return tool.execute(input, { toolCallId: "t1", messages: [] });
}

describe("createEditTool", () => {
  it("applies a single edit and returns diff details", async () => {
    const store = new InMemoryFileStore();
    await store.write("/a.txt", enc.encode("hello world\n"));
    const tool = createEditTool({ store });
    const out = await exec(tool, {
      path: "/a.txt",
      edits: [{ oldText: "world", newText: "there" }],
    });
    expect(out.editsApplied).toBe(1);
    expect(out.diff).toContain("hello");
    expect(out.patch).toMatch(/--- /);
    const buf = await store.readAll("/a.txt");
    expect(buf && dec.decode(buf)).toBe("hello there\n");
  });

  it("applies multiple disjoint edits in one call", async () => {
    const store = new InMemoryFileStore();
    await store.write("/a.txt", enc.encode("alpha beta gamma\n"));
    const tool = createEditTool({ store });
    const out = await exec(tool, {
      path: "/a.txt",
      edits: [
        { oldText: "alpha", newText: "A" },
        { oldText: "gamma", newText: "G" },
      ],
    });
    expect(out.editsApplied).toBe(2);
    const buf = await store.readAll("/a.txt");
    expect(buf && dec.decode(buf)).toBe("A beta G\n");
  });

  it("preserves CRLF line endings", async () => {
    const store = new InMemoryFileStore();
    await store.write("/a.txt", enc.encode("a\r\nb\r\nc\r\n"));
    const tool = createEditTool({ store });
    await exec(tool, { path: "/a.txt", edits: [{ oldText: "b", newText: "B" }] });
    const buf = await store.readAll("/a.txt");
    expect(buf && dec.decode(buf)).toBe("a\r\nB\r\nc\r\n");
  });

  it("preserves a leading BOM", async () => {
    const store = new InMemoryFileStore();
    await store.write("/a.txt", enc.encode("\uFEFFhello world"));
    const tool = createEditTool({ store });
    await exec(tool, { path: "/a.txt", edits: [{ oldText: "world", newText: "there" }] });
    const buf = await store.readAll("/a.txt");
    expect(buf && new TextDecoder("utf-8", { ignoreBOM: true }).decode(buf)).toBe("\uFEFFhello there");
  });

  it("returns an error when the file is missing", async () => {
    const store = new InMemoryFileStore();
    const tool = createEditTool({ store });
    const out = await exec(tool, {
      path: "/nope",
      edits: [{ oldText: "x", newText: "y" }],
    });
    expect(out.error).toMatch(/not found/i);
  });

  it("returns an error when oldText is not unique", async () => {
    const store = new InMemoryFileStore();
    await store.write("/a.txt", enc.encode("foo foo"));
    const tool = createEditTool({ store });
    const out = await exec(tool, {
      path: "/a.txt",
      edits: [{ oldText: "foo", newText: "bar" }],
    });
    expect(out.error).toMatch(/2 occurrences/);
    // File must not have been modified on failure.
    expect(dec.decode((await store.readAll("/a.txt"))!)).toBe("foo foo");
  });

  it("returns an error when edits overlap", async () => {
    const store = new InMemoryFileStore();
    await store.write("/a.txt", enc.encode("abcdef"));
    const tool = createEditTool({ store });
    const out = await exec(tool, {
      path: "/a.txt",
      edits: [
        { oldText: "abcd", newText: "X" },
        { oldText: "cdef", newText: "Y" },
      ],
    });
    expect(out.error).toMatch(/overlap/);
  });

  it("rejects files larger than maxBytes", async () => {
    const store = new InMemoryFileStore();
    await store.write("/big", enc.encode("x".repeat(100)));
    const tool = createEditTool({ store, maxBytes: 50 });
    const out = await exec(tool, {
      path: "/big",
      edits: [{ oldText: "x", newText: "y" }],
    });
    expect(out.error).toMatch(/too large/i);
  });

  it("tolerates legacy oldText/newText siblings", async () => {
    const store = new InMemoryFileStore();
    await store.write("/a.txt", enc.encode("hello world"));
    const tool = createEditTool({ store });
    // ai-sdk validates against the schema, so submit through the exposed
    // schema-bypass execute path — same shape some models actually send.
    const out = await exec(tool, {
      path: "/a.txt",
      edits: [],
      oldText: "world",
      newText: "there",
    } as any);
    expect(out.editsApplied).toBe(1);
  });

  it("tolerates edits sent as a JSON string", async () => {
    const store = new InMemoryFileStore();
    await store.write("/a.txt", enc.encode("hello world"));
    const tool = createEditTool({ store });
    const out = await exec(tool, {
      path: "/a.txt",
      edits: JSON.stringify([{ oldText: "world", newText: "there" }]),
    } as any);
    expect(out.editsApplied).toBe(1);
  });

  it("serializes concurrent edits to the same file", async () => {
    const store = new InMemoryFileStore();
    await store.write("/a.txt", enc.encode("123456789"));
    const tool = createEditTool({ store });
    const results = await Promise.all([
      exec(tool, { path: "/a.txt", edits: [{ oldText: "1", newText: "A" }] }),
      exec(tool, { path: "/a.txt", edits: [{ oldText: "9", newText: "Z" }] }),
    ]);
    expect(results.every(r => r.editsApplied === 1)).toBe(true);
    // Final state must reflect both edits regardless of arrival order — that's
    // only possible if they didn't race on the read/modify/write window.
    const buf = await store.readAll("/a.txt");
    expect(dec.decode(buf!)).toBe("A2345678Z");
  });

  it("preserves the existing file's mode when applying an edit", async () => {
    // Regression: the agent's edit tool used to call store.write(path, bytes)
    // with no mode, which silently downgraded executable scripts (0o100755)
    // to the default regular-file mode (0o100644). The repo's two executable
    // scripts (sync-host-ca.sh, sync-skills.mjs) lost their +x bit this way.
    const store = new InMemoryFileStore();
    await store.write("/script.sh", enc.encode("#!/bin/sh\necho hi\n"), { mode: 0o100755 });
    const tool = createEditTool({ store });
    const out = await exec(tool, {
      path: "/script.sh",
      edits: [{ oldText: "echo hi", newText: "echo hello" }],
    });
    expect(out.editsApplied).toBe(1);
    const after = await store.stat("/script.sh");
    expect(after?.mode).toBe(0o100755);
  });
});
