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

test("implemented FUSE ops all have explicit current expectations", async () => {
  const vfs = new MemoryVfs();
  const ops = makeFuseOps(vfs);

  assert.equal(await status((cb) => ops.init(cb)), 0);

  assert.equal(await status((cb) => ops.mkdir("/dir", 0o755, cb)), 0);
  assert.equal(await status((cb) => ops.access("/dir", 0, cb)), 0);
  assert.equal(await status((cb) => ops.access("/missing", 0, cb)), -2);

  const rootDir = await callback((cb) => ops.opendir("/", 0, cb));
  assert.equal(rootDir.errno, 0);
  assert.equal(typeof rootDir.result, "number");
  assert.equal(await status((cb) => ops.releasedir("/", rootDir.result, cb)), 0);

  const create = await callback((cb) => ops.create("/dir/file.txt", 0o644, cb));
  assert.equal(create.errno, 0);
  assert.equal(typeof create.result, "number");

  const open = await callback((cb) => ops.open("/dir/file.txt", 0, cb));
  assert.equal(open.errno, 0);
  assert.equal(typeof open.result, "number");

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

  const statfs = await callback((cb) => ops.statfs("/", cb));
  assert.equal(statfs.errno, 0);
  assert.equal(statfs.result.bsize, 4096);
  assert.equal(statfs.result.namemax, 255);

  assert.equal(await status((cb) => ops.chmod("/dir/file.txt", 0o600, cb)), 0);
  const chmodStat = await callback((cb) => ops.getattr("/dir/file.txt", cb));
  assert.equal(chmodStat.errno, 0);
  assert.equal(chmodStat.result.mode & 0o777, 0o600);

  assert.equal(await status((cb) => ops.chown("/dir/file.txt", 123, 456, cb)), 0);
  assert.equal(await status((cb) => ops.flush("/dir/file.txt", create.result, cb)), 0);
  assert.equal(await status((cb) => ops.fsync("/dir/file.txt", create.result, 0, cb)), 0);
  assert.equal(await status((cb) => ops.fsyncdir("/dir", rootDir.result, 0, cb)), 0);

  assert.equal(await status((cb) => ops.setxattr("/dir/file.txt", "user.test", Buffer.from("value"), 0, 0, cb)), 0);
  assert.equal(await status((cb) => ops.getxattr("/dir/file.txt", "user.test", 0, cb)), -61);
  const xattrs = await callback((cb) => ops.listxattr("/dir/file.txt", cb));
  assert.equal(xattrs.errno, 0);
  assert.equal(Buffer.isBuffer(xattrs.result), true);
  assert.equal(xattrs.result.length, 0);
  assert.equal(await status((cb) => ops.removexattr("/dir/file.txt", "user.test", cb)), -61);

  assert.equal(await status((cb) => ops.rename("/dir/file.txt", "/dir/renamed.txt", cb)), 0);
  assert.equal(vfs.readFile("/dir/renamed.txt").toString(), "hello fuse");

  assert.equal(await status((cb) => ops.truncate("/dir/renamed.txt", 5, cb)), 0);
  assert.equal(vfs.readFile("/dir/renamed.txt").toString(), "hello");

  assert.equal(await status((cb) => ops.ftruncate("/dir/renamed.txt", create.result, 2, cb)), 0);
  assert.equal(vfs.readFile("/dir/renamed.txt").toString(), "he");

  assert.equal(await status((cb) => ops.release("/dir/renamed.txt", create.result, cb)), 0);
  assert.equal(await status((cb) => ops.release("/dir/renamed.txt", open.result, cb)), 0);
  assert.equal(await status((cb) => ops.unlink("/dir/renamed.txt", cb)), 0);
  assert.deepEqual(vfs.readdir("/dir"), []);
  assert.equal(await status((cb) => ops.rmdir("/dir", cb)), 0);
  assert.deepEqual(vfs.readdir("/"), []);
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
