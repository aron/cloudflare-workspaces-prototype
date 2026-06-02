const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { createNodeVirtualFileSystem } = require("../../dist/fuse/index.js");
const { mountShim } = require("../../dist/shim/index.js");

// Poll cadence for the assertions below. We pass the same value into
// the shim so the disk -> VFS reconcile fires this often, and use a
// multiple of it for wait deadlines.
const TICK_MS = 50;

async function eventually(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, TICK_MS));
  }
  if (lastError) throw lastError;
  throw new Error("eventually(): condition never became true");
}

async function setup(t: any) {
  const mountPoint = await fs.mkdtemp(path.join(os.tmpdir(), "wsd-shim-"));
  const { vfs } = await createNodeVirtualFileSystem();
  const shim = await mountShim({ vfs, mountPoint, pollIntervalMs: TICK_MS });
  t.after(async () => {
    await shim.unmount();
    await fs.rm(mountPoint, { recursive: true, force: true });
  });
  return { vfs, mountPoint, shim };
}

test("shim mirrors VFS writes onto disk", async (t) => {
  const { vfs, mountPoint } = await setup(t);
  vfs.mkdirSync("/proj", { recursive: true });
  vfs.writeFileSync("/proj/hello.txt", Buffer.from("hello"));

  await eventually(async () => {
    const buf = await fs.readFile(path.join(mountPoint, "proj", "hello.txt"), "utf8");
    assert.equal(buf, "hello");
    return true;
  });
});

test("shim mirrors disk writes back into the VFS", async (t) => {
  const { vfs, mountPoint } = await setup(t);
  await fs.mkdir(path.join(mountPoint, "sub"));
  await fs.writeFile(path.join(mountPoint, "sub", "note.md"), "from host");

  await eventually(() => {
    const text = vfs.readFileSync("/sub/note.md").toString();
    assert.equal(text, "from host");
    return true;
  });
});

test("shim mirrors deletions in both directions", async (t) => {
  const { vfs, mountPoint } = await setup(t);

  // VFS -> disk delete.
  vfs.writeFileSync("/a.txt", Buffer.from("a"));
  await eventually(async () => {
    await fs.access(path.join(mountPoint, "a.txt"));
    return true;
  });
  vfs.unlinkSync("/a.txt");
  await eventually(async () => {
    try {
      await fs.access(path.join(mountPoint, "a.txt"));
      return false;
    } catch {
      return true;
    }
  });

  // Disk -> VFS delete.
  await fs.writeFile(path.join(mountPoint, "b.txt"), "b");
  await eventually(() => vfs.existsSync("/b.txt"));
  await fs.rm(path.join(mountPoint, "b.txt"));
  await eventually(() => !vfs.existsSync("/b.txt"));
});

test("shim does not echo identical writes back and forth", async (t) => {
  const { vfs, mountPoint } = await setup(t);
  vfs.writeFileSync("/stable.txt", Buffer.from("same"));

  await eventually(async () => {
    const buf = await fs.readFile(path.join(mountPoint, "stable.txt"), "utf8");
    return buf === "same";
  });

  // Touch the file on disk with identical content; the shim's
  // content-equal short-circuit should keep VFS mtime stable.
  const before = vfs.statSync("/stable.txt").mtime.getTime();
  // Wait a beat so any spurious bump from an mtime-only change shows
  // up as a different value.
  await new Promise((resolve) => setTimeout(resolve, TICK_MS * 4));
  await fs.writeFile(path.join(mountPoint, "stable.txt"), "same");
  await new Promise((resolve) => setTimeout(resolve, TICK_MS * 6));
  const after = vfs.statSync("/stable.txt").mtime.getTime();
  assert.equal(after, before, "identical disk write should not bump VFS mtime");
});

test("shim picks up nested directory creates on disk", async (t) => {
  const { vfs, mountPoint } = await setup(t);
  await fs.mkdir(path.join(mountPoint, "a", "b", "c"), { recursive: true });
  await fs.writeFile(path.join(mountPoint, "a", "b", "c", "leaf.txt"), "leaf");

  await eventually(() => {
    const text = vfs.readFileSync("/a/b/c/leaf.txt").toString();
    assert.equal(text, "leaf");
    return true;
  });
});
