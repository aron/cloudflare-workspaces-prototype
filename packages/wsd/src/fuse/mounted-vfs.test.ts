const assert = require("node:assert/strict");
const { test } = require("node:test");
const { VirtualProvider } = require("@platformatic/vfs");

const { createNodeVirtualFileSystem, createMountedVfs } = require("../../dist/fuse/index.js");

async function nextEvent(watcher) {
  const iterator = watcher[Symbol.asyncIterator]();
  try {
    const result = await Promise.race([
      iterator.next(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("watch timed out")), 1_000)),
    ]);
    return result.value;
  } finally {
    await watcher.return?.();
  }
}

test("mounted VFS handles every upstream provider member explicitly", async () => {
  const { vfs } = await createNodeVirtualFileSystem();
  const provider = createMountedVfs(vfs, "/workspace").provider;
  const mountedPrototype = Object.getPrototypeOf(provider);

  for (const name of Object.getOwnPropertyNames(VirtualProvider.prototype)) {
    if (name === "constructor") continue;
    const mounted = Object.getOwnPropertyDescriptor(mountedPrototype, name);
    const base = Object.getOwnPropertyDescriptor(VirtualProvider.prototype, name);
    assert.ok(mounted, `${name} must be handled by MountedSubtreeProvider`);
    assert.notEqual(
      mounted.value ?? mounted.get,
      base?.value ?? base?.get,
      `${name} must not inherit VirtualProvider's default implementation`,
    );
  }
});

test("mounted VFS exposes a backing subtree as its root", async () => {
  const { vfs } = await createNodeVirtualFileSystem();
  vfs.mkdirSync("/workspace/repo", { recursive: true });
  vfs.writeFileSync("/workspace/repo/a.txt", Buffer.from("alpha"));

  const mounted = createMountedVfs(vfs, "/workspace");

  assert.deepEqual(mounted.readdirSync("/repo"), ["a.txt"]);
  const [dirent] = mounted.readdirSync("/repo", { withFileTypes: true });
  assert.equal(dirent.name, "a.txt");
  assert.equal(dirent.path, "/repo/a.txt");
  assert.equal(dirent.parentPath, "/repo");
  assert.equal(mounted.readFileSync("/repo/a.txt").toString(), "alpha");
  assert.equal(mounted.realpathSync("/repo/a.txt"), "/repo/a.txt");

  mounted.writeFileSync("/repo/b.txt", Buffer.from("bravo"));

  assert.equal(vfs.readFileSync("/workspace/repo/b.txt").toString(), "bravo");
  assert.equal(vfs.existsSync("/repo/b.txt"), false);
});

test("mounted VFS watches report mount-relative filenames", async () => {
  const { vfs } = await createNodeVirtualFileSystem();
  vfs.mkdirSync("/workspace", { recursive: true });

  const mounted = createMountedVfs(vfs, "/workspace");
  const watcher = mounted.provider.watchAsync("/", { recursive: true, interval: 10 });

  vfs.mkdirSync("/workspace/repo", { recursive: true });
  vfs.writeFileSync("/workspace/repo/a.txt", Buffer.from("alpha"));

  const event = await nextEvent(watcher);
  assert.match(event.filename, /^repo(?:\/a\.txt)?$/);
});

test("mounted VFS canonicalizes absolute roots and rejects relative roots", async () => {
  const { vfs } = await createNodeVirtualFileSystem();

  const mounted = createMountedVfs(vfs, "/workspace/../workspace/");
  mounted.mkdirSync("/repo", { recursive: true });

  assert.equal(vfs.existsSync("/workspace/repo"), true);
  assert.equal(mounted.realpathSync("/repo"), "/repo");
  assert.throws(() => createMountedVfs(vfs, "workspace"), /absolute/);
});

test("mounted VFS preserves symlink target text", async () => {
  const { vfs } = await createNodeVirtualFileSystem();
  vfs.mkdirSync("/workspace", { recursive: true });

  const mounted = createMountedVfs(vfs, "/workspace");
  mounted.symlinkSync("/workspace/repo/a.txt", "/link");

  assert.equal(mounted.readlinkSync("/link"), "/workspace/repo/a.txt");
  assert.equal(vfs.readlinkSync("/workspace/link"), "/workspace/repo/a.txt");
});

test("mounted VFS preserves provider file descriptor extensions", async () => {
  const { vfs } = await createNodeVirtualFileSystem();
  vfs.mkdirSync("/workspace", { recursive: true });

  const provider = createMountedVfs(vfs, "/workspace").provider;
  for (const name of [
    "closeSync",
    "readSync",
    "writeSync",
    "fstatSync",
    "truncateSync",
    "ftruncateSync",
  ]) {
    assert.equal(typeof provider[name], "function", `${name} should be forwarded`);
  }
  const fd = provider.openSync("/fd.txt", "w+");
  const bytes = Buffer.from("via fd");

  try {
    assert.equal(provider.writeSync(fd, bytes, 0, bytes.length, 0), bytes.length);
    assert.equal(provider.fstatSync(fd).size, bytes.length);
    provider.truncateSync("/fd.txt", 3);
    assert.equal(provider.ftruncateSync(fd, 2), undefined);
  } finally {
    provider.closeSync(fd);
  }

  assert.equal(vfs.readFileSync("/workspace/fd.txt").toString(), "vi");
});
