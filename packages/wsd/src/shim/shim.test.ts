import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, onTestFinished, test } from "vitest";

import { createNodeVirtualFileSystem } from "../fuse/index.js";
import { mountShim } from "./index.js";

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

async function setup() {
  const mountPoint = await fs.mkdtemp(path.join(os.tmpdir(), "wsd-shim-"));
  const { vfs } = await createNodeVirtualFileSystem();
  const shim = await mountShim({ vfs, mountPoint, pollIntervalMs: TICK_MS });
  onTestFinished(async () => {
    await shim.unmount();
    await fs.rm(mountPoint, { recursive: true, force: true });
  });
  return { vfs, mountPoint, shim };
}

test("shim mirrors VFS writes onto disk", async (ctx) => {
  const { vfs, mountPoint } = await setup();
  vfs.mkdirSync("/proj", { recursive: true });
  vfs.writeFileSync("/proj/hello.txt", Buffer.from("hello"));

  await eventually(async () => {
    const buf = await fs.readFile(path.join(mountPoint, "proj", "hello.txt"), "utf8");
    expect(buf).toBe("hello");
    return true;
  });
});

test("shim mirrors disk writes back into the VFS", async (ctx) => {
  const { vfs, mountPoint } = await setup();
  await fs.mkdir(path.join(mountPoint, "sub"));
  await fs.writeFile(path.join(mountPoint, "sub", "note.md"), "from host");

  await eventually(() => {
    const text = vfs.readFileSync("/sub/note.md").toString();
    expect(text).toBe("from host");
    return true;
  });
});

test("shim mirrors deletions in both directions", async (ctx) => {
  const { vfs, mountPoint } = await setup();

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

test("shim does not echo identical writes back and forth", async (ctx) => {
  const { vfs, mountPoint } = await setup();
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
  expect(after).toBe(before, "identical disk write should not bump VFS mtime");
});

test("shim picks up nested directory creates on disk", async (ctx) => {
  const { vfs, mountPoint } = await setup();
  await fs.mkdir(path.join(mountPoint, "a", "b", "c"), { recursive: true });
  await fs.writeFile(path.join(mountPoint, "a", "b", "c", "leaf.txt"), "leaf");

  await eventually(() => {
    const text = vfs.readFileSync("/a/b/c/leaf.txt").toString();
    expect(text).toBe("leaf");
    return true;
  });
});

test("shim.flush() settles VFS writes onto disk before resolving", async (ctx) => {
  // Use a very slow poll so the watcher/poll loops can't accidentally
  // serve the assertion. If flush() works, the file is on disk before
  // any tick fires; if it doesn't, the read fails because nothing else
  // has materialised it yet.
  const mountPoint = await fs.mkdtemp(path.join(os.tmpdir(), "wsd-shim-flush-"));
  const { vfs } = await createNodeVirtualFileSystem();
  const shim = await mountShim({ vfs, mountPoint, pollIntervalMs: 60_000 });
  onTestFinished(async () => {
    await shim.unmount();
    await fs.rm(mountPoint, { recursive: true, force: true });
  });

  vfs.mkdirSync("/proj", { recursive: true });
  vfs.writeFileSync("/proj/a.txt", Buffer.from("alpha"));
  vfs.writeFileSync("/proj/b.txt", Buffer.from("beta"));

  await shim.flush();

  expect(await fs.readFile(path.join(mountPoint, "proj", "a.txt"), "utf8")).toBe("alpha");
  expect(await fs.readFile(path.join(mountPoint, "proj", "b.txt"), "utf8")).toBe("beta");
});

test("shim.flush() is idempotent and cheap on a clean tree", async (ctx) => {
  // Second flush should be a no-op (shadow short-circuits every
  // syncVfsPathToDisk call) and complete promptly.
  const { vfs, mountPoint, shim } = await setup();
  vfs.writeFileSync("/hello.txt", Buffer.from("world"));
  await shim.flush();
  const mtime1 = (await fs.stat(path.join(mountPoint, "hello.txt"))).mtimeMs;
  await shim.flush();
  const mtime2 = (await fs.stat(path.join(mountPoint, "hello.txt"))).mtimeMs;
  expect(mtime2).toBe(mtime1, "flush should not rewrite an unchanged file");
});

test("shim.flush() resolves on an unmounted shim without throwing", async (ctx) => {
  const mountPoint = await fs.mkdtemp(path.join(os.tmpdir(), "wsd-shim-flush-unmount-"));
  const { vfs } = await createNodeVirtualFileSystem();
  const shim = await mountShim({ vfs, mountPoint, pollIntervalMs: TICK_MS });
  onTestFinished(async () => {
    await fs.rm(mountPoint, { recursive: true, force: true });
  });
  await shim.unmount();
  await shim.flush();
});
