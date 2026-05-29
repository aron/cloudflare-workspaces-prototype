const assert = require("node:assert/strict");
const { test } = require("node:test");

const { NotImplementedError, makeFuseOps } = require("../dist/fuse/driver.js");
const { MemoryVfs } = require("../dist/fuse/vfs.js");

const callback = (fn) => new Promise((resolve) => fn((errno, result) => resolve({ errno, result })));
const status = (fn) => new Promise((resolve) => fn((value) => resolve(value)));

const fuseNativeOperationNames = [
  "init",
  "error",
  "access",
  "statfs",
  "fgetattr",
  "getattr",
  "flush",
  "fsync",
  "fsyncdir",
  "readdir",
  "truncate",
  "ftruncate",
  "utimens",
  "readlink",
  "chown",
  "chmod",
  "mknod",
  "setxattr",
  "getxattr",
  "listxattr",
  "removexattr",
  "open",
  "opendir",
  "read",
  "write",
  "release",
  "releasedir",
  "create",
  "unlink",
  "rename",
  "link",
  "symlink",
  "mkdir",
  "rmdir",
];

const notImplementedOperationNames = [
  "error",
  "utimens",
  "readlink",
  "mknod",
  "link",
  "symlink",
];

test("FUSE ops expose the complete fuse-native operation surface", () => {
  const ops = makeFuseOps(new MemoryVfs());

  for (const name of fuseNativeOperationNames) {
    assert.equal(typeof ops[name], "function", `${name} should be defined`);
  }
});

test("not-yet-implemented FUSE ops raise NotImplementedError", () => {
  const ops = makeFuseOps(new MemoryVfs());

  for (const name of notImplementedOperationNames) {
    assert.throws(
      () => ops[name](),
      (error) => error instanceof NotImplementedError && error.operation === name,
      `${name} should raise NotImplementedError`,
    );
  }
});

test("FUSE ops expose an in-memory filesystem", async () => {
  const vfs = new MemoryVfs();
  const ops = makeFuseOps(vfs);

  assert.equal(await status((cb) => ops.mkdir("/dir", 0o755, cb)), 0);

  const create = await callback((cb) => ops.create("/dir/file.txt", 0o644, cb));
  assert.equal(create.errno, 0);
  assert.equal(typeof create.result, "number");

  const bytes = Buffer.from("hello fuse");
  assert.equal(await status((cb) => ops.write("/dir/file.txt", create.result, bytes, bytes.length, 0, cb)), bytes.length);

  const readBuffer = Buffer.alloc(bytes.length);
  assert.equal(await status((cb) => ops.read("/dir/file.txt", create.result, readBuffer, readBuffer.length, 0, cb)), bytes.length);
  assert.equal(readBuffer.toString(), "hello fuse");

  const dir = await callback((cb) => ops.readdir("/dir", cb));
  assert.equal(dir.errno, 0);
  assert.deepEqual(dir.result, ["file.txt"]);

  const stat = await callback((cb) => ops.getattr("/dir/file.txt", cb));
  assert.equal(stat.errno, 0);
  assert.equal(stat.result.size, bytes.length);
  assert.equal(stat.result.mode & 0o170000, 0o100000);

  const fstat = await callback((cb) => ops.fgetattr("/dir/file.txt", create.result, cb));
  assert.equal(fstat.errno, 0);
  assert.equal(fstat.result.size, bytes.length);

  assert.equal(await status((cb) => ops.rename("/dir/file.txt", "/dir/renamed.txt", cb)), 0);
  assert.equal(vfs.readFile("/dir/renamed.txt").toString(), "hello fuse");

  assert.equal(await status((cb) => ops.truncate("/dir/renamed.txt", 5, cb)), 0);
  assert.equal(vfs.readFile("/dir/renamed.txt").toString(), "hello");

  assert.equal(await status((cb) => ops.ftruncate("/dir/renamed.txt", create.result, 2, cb)), 0);
  assert.equal(vfs.readFile("/dir/renamed.txt").toString(), "he");

  assert.equal(await status((cb) => ops.unlink("/dir/renamed.txt", cb)), 0);
  assert.deepEqual(vfs.readdir("/dir"), []);
});

test("FUSE ops return errno values instead of throwing for expected filesystem errors", async () => {
  const ops = makeFuseOps(new MemoryVfs());

  const missing = await callback((cb) => ops.getattr("/missing", cb));
  assert.equal(missing.errno, -2);

  assert.equal(await status((cb) => ops.open("/missing", 0, cb)), -2);
  assert.equal(await status((cb) => ops.unlink("/missing", cb)), -2);
});
