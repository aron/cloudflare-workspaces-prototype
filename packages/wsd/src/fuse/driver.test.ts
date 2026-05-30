const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  NotImplementedError,
  createNodeVirtualFileSystem,
  makeFUSEOps,
} = require("../../dist/fuse/index.js");

const callback = (fn: (cb: (errno: number, result: unknown) => void) => void) =>
  new Promise<{ errno: number; result: unknown }>((resolve) =>
    fn((errno, result) => resolve({ errno, result })),
  );
const status = (fn: (cb: (value: number) => void) => void) =>
  new Promise<number>((resolve) => fn((value) => resolve(value)));

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

const notImplementedOperationNames = ["error", "mknod", "link"];

test("FUSE ops expose the complete fuse-native operation surface", () => {
  const ops = makeFUSEOps(createNodeVirtualFileSystem());

  for (const name of fuseNativeOperationNames) {
    assert.equal(typeof ops[name], "function", `${name} should be defined`);
  }
});

test("not-yet-implemented FUSE ops invoke their callback with ENOSYS", async () => {
  const ops = makeFUSEOps(createNodeVirtualFileSystem());
  const ENOSYS = -38;

  for (const name of notImplementedOperationNames) {
    if (name === "error") continue; // error has no callback arg
    const errno = await new Promise<number>((resolve) => {
      // Call with a single argument: the callback.
      (ops as Record<string, (...args: unknown[]) => void>)[name](resolve);
    });
    assert.equal(errno, ENOSYS, `${name} should return ENOSYS`);
  }
});

test("implemented FUSE ops all have explicit current expectations", async () => {
  const vfs = createNodeVirtualFileSystem();
  const ops = makeFUSEOps(vfs);

  assert.equal(await status((cb) => ops.init(cb)), 0);

  assert.equal(await status((cb) => ops.mkdir("/dir", 0o755, cb)), 0);
  assert.equal(await status((cb) => ops.access("/dir", 0, cb)), 0);
  assert.equal(await status((cb) => ops.access("/missing", 0, cb)), -2);

  const rootDir = await callback((cb) => ops.opendir("/", 0, cb));
  assert.equal(rootDir.errno, 0);
  assert.equal(typeof rootDir.result, "number");
  assert.equal(await status((cb) => ops.releasedir("/", rootDir.result as number, cb)), 0);

  const create = await callback((cb) => ops.create("/dir/file.txt", 0o644, cb));
  assert.equal(create.errno, 0);
  assert.equal(typeof create.result, "number");

  const open = await callback((cb) => ops.open("/dir/file.txt", 0, cb));
  assert.equal(open.errno, 0);
  assert.equal(typeof open.result, "number");

  const bytes = Buffer.from("hello fuse");
  assert.equal(
    await status((cb) =>
      ops.write("/dir/file.txt", create.result as number, bytes, bytes.length, 0, cb),
    ),
    bytes.length,
  );

  const readBuffer = Buffer.alloc(bytes.length);
  assert.equal(
    await status((cb) =>
      ops.read("/dir/file.txt", create.result as number, readBuffer, readBuffer.length, 0, cb),
    ),
    bytes.length,
  );
  assert.equal(readBuffer.toString(), "hello fuse");

  const dir = await callback((cb) => ops.readdir("/dir", cb));
  assert.equal(dir.errno, 0);
  assert.deepEqual(dir.result, ["file.txt"]);

  const stat = await callback((cb) => ops.getattr("/dir/file.txt", cb));
  assert.equal(stat.errno, 0);
  assert.equal((stat.result as { size: number }).size, bytes.length);

  const fstat = await callback((cb) => ops.fgetattr("/dir/file.txt", create.result as number, cb));
  assert.equal(fstat.errno, 0);
  assert.equal((fstat.result as { size: number }).size, bytes.length);

  const statfs = await callback((cb) => ops.statfs("/", cb));
  assert.equal(statfs.errno, 0);
  assert.equal((statfs.result as { bsize: number; namemax: number }).bsize, 4096);
  assert.equal((statfs.result as { bsize: number; namemax: number }).namemax, 255);

  assert.equal(await status((cb) => ops.chmod("/dir/file.txt", 0o600, cb)), 0);
  assert.equal(await status((cb) => ops.chown("/dir/file.txt", 123, 456, cb)), 0);
  assert.equal(await status((cb) => ops.flush("/dir/file.txt", create.result as number, cb)), 0);
  assert.equal(await status((cb) => ops.fsync("/dir/file.txt", create.result as number, 0, cb)), 0);
  assert.equal(await status((cb) => ops.fsyncdir("/dir", rootDir.result as number, 0, cb)), 0);

  assert.equal(
    await status((cb) =>
      ops.setxattr("/dir/file.txt", "user.test", Buffer.from("value"), 0, 0, cb),
    ),
    0,
  );
  assert.equal(await status((cb) => ops.getxattr("/dir/file.txt", "user.test", 0, cb)), -61);
  const xattrs = await callback((cb) => ops.listxattr("/dir/file.txt", cb));
  assert.equal(xattrs.errno, 0);
  assert.equal(Buffer.isBuffer(xattrs.result), true);
  assert.equal((xattrs.result as Buffer).length, 0);
  assert.equal(await status((cb) => ops.removexattr("/dir/file.txt", "user.test", cb)), -61);
  assert.equal(await status((cb) => ops.utimens("/dir/file.txt", Date.now(), Date.now(), cb)), 0);
  assert.equal(await status((cb) => ops.utimens("/missing", Date.now(), Date.now(), cb)), -2);

  assert.equal(await status((cb) => ops.rename("/dir/file.txt", "/dir/renamed.txt", cb)), 0);
  const renamedBuf = Buffer.alloc(64);
  assert.equal(
    await status((cb) => ops.read("/dir/renamed.txt", 0, renamedBuf, renamedBuf.length, 0, cb)),
    bytes.length,
  );
  assert.equal(renamedBuf.subarray(0, bytes.length).toString(), "hello fuse");

  assert.equal(await status((cb) => ops.truncate("/dir/renamed.txt", 5, cb)), 0);
  const truncBuf = Buffer.alloc(64);
  assert.equal(
    await status((cb) => ops.read("/dir/renamed.txt", 0, truncBuf, truncBuf.length, 0, cb)),
    5,
  );
  assert.equal(truncBuf.subarray(0, 5).toString(), "hello");

  assert.equal(
    await status((cb) => ops.ftruncate("/dir/renamed.txt", create.result as number, 2, cb)),
    0,
  );
  const ftruncBuf = Buffer.alloc(64);
  assert.equal(
    await status((cb) => ops.read("/dir/renamed.txt", 0, ftruncBuf, ftruncBuf.length, 0, cb)),
    2,
  );
  assert.equal(ftruncBuf.subarray(0, 2).toString(), "he");

  assert.equal(
    await status((cb) => ops.release("/dir/renamed.txt", create.result as number, cb)),
    0,
  );
  assert.equal(await status((cb) => ops.release("/dir/renamed.txt", open.result as number, cb)), 0);
  assert.equal(await status((cb) => ops.unlink("/dir/renamed.txt", cb)), 0);
  assert.deepEqual(vfs.readdirSync("/dir"), []);
  assert.equal(await status((cb) => ops.rmdir("/dir", cb)), 0);
  assert.deepEqual(vfs.readdirSync("/"), []);
});

test("FUSE ops return errno values instead of throwing for expected filesystem errors", async () => {
  const ops = makeFUSEOps(createNodeVirtualFileSystem());

  const missing = await callback((cb) => ops.getattr("/missing", cb));
  assert.equal(missing.errno, -2);

  assert.equal(await status((cb) => ops.open("/missing", 0, cb)), -2);
  assert.equal(await status((cb) => ops.unlink("/missing", cb)), -2);
});
