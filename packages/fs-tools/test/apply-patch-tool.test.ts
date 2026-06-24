import { describe, expect, it } from "vitest";
import { InMemoryFileStore } from "../src/stores/in-memory.js";
import { createApplyPatchTool } from "../src/tools/apply-patch.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

async function exec(tool: any, input: any) {
  return tool.execute(input, { toolCallId: "t1", messages: [] });
}

describe("createApplyPatchTool", () => {
  it("creates a file from a create_file V4A diff", async () => {
    const store = new InMemoryFileStore();
    const tool = createApplyPatchTool({ store });

    const out = await exec(tool, {
      operation: {
        type: "create_file",
        path: "/new.txt",
        diff: "+hello\n+world\n",
      },
    });

    expect(out).toMatchObject({ status: "completed", operation: "create_file", path: "/new.txt" });
    expect(dec.decode((await store.readAll("/new.txt"))!)).toBe("hello\nworld");
    expect(out.patch).toContain("+++ ");
  });

  it("updates an existing file from a headerless V4A diff", async () => {
    const store = new InMemoryFileStore();
    await store.write("/a.txt", enc.encode("alpha\nbeta\ngamma\n"));
    const tool = createApplyPatchTool({ store });

    const out = await exec(tool, {
      operation: {
        type: "update_file",
        path: "/a.txt",
        diff: "@@\n alpha\n-beta\n+BETA\n gamma\n",
      },
    });

    expect(out).toMatchObject({ status: "completed", operation: "update_file", path: "/a.txt" });
    expect(dec.decode((await store.readAll("/a.txt"))!)).toBe("alpha\nBETA\ngamma\n");
  });

  it("preserves CRLF line endings and the existing file mode", async () => {
    const store = new InMemoryFileStore();
    await store.write("/run.sh", enc.encode("one\r\ntwo\r\n"), { mode: 0o100755 });
    const tool = createApplyPatchTool({ store });

    await exec(tool, {
      operation: {
        type: "update_file",
        path: "/run.sh",
        diff: "@@\n one\n-two\n+TWO\n",
      },
    });

    expect(dec.decode((await store.readAll("/run.sh"))!)).toBe("one\r\nTWO\r\n");
    expect((await store.stat("/run.sh"))?.mode).toBe(0o100755);
  });

  it("deletes a file", async () => {
    const store = new InMemoryFileStore();
    await store.write("/gone.txt", enc.encode("bye\n"));
    const tool = createApplyPatchTool({ store });

    const out = await exec(tool, { operation: { type: "delete_file", path: "/gone.txt" } });

    expect(out).toMatchObject({ status: "completed", operation: "delete_file", path: "/gone.txt" });
    expect(await store.stat("/gone.txt")).toBeNull();
  });

  it("returns failed for missing update targets without modifying other files", async () => {
    const store = new InMemoryFileStore();
    await store.write("/keep.txt", enc.encode("keep"));
    const tool = createApplyPatchTool({ store });

    const out = await exec(tool, {
      operation: {
        type: "update_file",
        path: "/missing.txt",
        diff: "@@\n-old\n+new\n",
      },
    });

    expect(out.status).toBe("failed");
    expect(out.output).toMatch(/not found/i);
    expect(dec.decode((await store.readAll("/keep.txt"))!)).toBe("keep");
  });

  it("accepts operation fields at the root for model recovery", async () => {
    const store = new InMemoryFileStore();
    const tool = createApplyPatchTool({ store });

    const out = await exec(tool, {
      type: "create_file",
      path: "/root-shape.txt",
      diff: "+ok",
    });

    expect(out.status).toBe("completed");
    expect(dec.decode((await store.readAll("/root-shape.txt"))!)).toBe("ok");
  });
});
