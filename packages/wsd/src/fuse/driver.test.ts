const assert = require("node:assert/strict");
const { test } = require("node:test");

const { createNodeVirtualFileSystem, makeFUSEOps } = require("../../dist/fuse/index.js");

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

test("FUSE ops expose the complete fuse-native operation surface", async () => {
  const ops = makeFUSEOps((await createNodeVirtualFileSystem()).vfs);

  for (const name of fuseNativeOperationNames) {
    assert.equal(typeof ops[name], "function", `${name} should be defined`);
  }
});

test("not-yet-implemented FUSE ops invoke their callback with ENOSYS", async () => {
  const ops = makeFUSEOps((await createNodeVirtualFileSystem()).vfs);
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
  const { vfs } = await createNodeVirtualFileSystem();
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
  const ops = makeFUSEOps((await createNodeVirtualFileSystem()).vfs);

  const missing = await callback((cb) => ops.getattr("/missing", cb));
  assert.equal(missing.errno, -2);

  assert.equal(await status((cb) => ops.open("/missing", 0, cb)), -2);
  assert.equal(await status((cb) => ops.unlink("/missing", cb)), -2);
});

test("write past the per-file cap returns EFBIG instead of growing unbounded", async () => {
  // The driver keeps an in-memory buffer per file and doubles its
  // capacity on demand. Without a ceiling, a runaway client can OOM
  // the daemon. We cap per-file size at 256 MiB and surface EFBIG.
  const { vfs } = await createNodeVirtualFileSystem();
  const ops = makeFUSEOps(vfs);

  const create = await callback((cb: (errno: number, result: unknown) => void) =>
    ops.create("/big", 0o644, cb),
  );
  assert.equal(create.errno, 0);
  const fh = create.result as number;

  // Sized just past the cap. The driver allocates the buffer up-front
  // and writes into it, so this also catches an off-by-one in the
  // boundary check.
  const PAST_CAP = 256 * 1024 * 1024 + 1;
  const tinyBuffer = Buffer.alloc(1, 0x61);
  const written = await status((cb: (value: number) => void) =>
    ops.write("/big", fh, tinyBuffer, 1, PAST_CAP - 1, cb),
  );
  assert.equal(written, -27, "expected EFBIG (-27)");

  // Truncate past the cap should also refuse rather than allocate.
  const truncated = await status((cb: (value: number) => void) =>
    ops.truncate("/big", PAST_CAP, cb),
  );
  assert.equal(truncated, -27, "expected EFBIG (-27) from truncate");
});

test("FUSE write is visible through the backing VFS after release", async () => {
  // The production wsd-container example showed FUSE-written files
  // returning HTTP 200 / 0 bytes when read back via the RPC
  // surface. Root cause hypothesis: makeFUSEOps keeps a per-file
  // in-memory buffer (`files` Map) that .write() updates but
  // .release()/.flush()/.fsync() never spill into the backing VFS.
  // RPC readers go through the VFS, so they see the empty inode
  // create()'d up front and miss every subsequent write.
  //
  // This test pins the contract: after a create + write + release
  // sequence, the same path read through the VFS API returns the
  // bytes that were written. Failing today; will turn green once
  // the driver flushes its buffer on release (or write-through).
  const { vfs } = await createNodeVirtualFileSystem();
  const ops = makeFUSEOps(vfs);

  const create = await callback((cb: (errno: number, result: unknown) => void) =>
    ops.create("/from-fuse.txt", 0o644, cb),
  );
  assert.equal(create.errno, 0);
  const fh = create.result as number;

  const payload = Buffer.from("from-fuse\n", "utf8");
  const written = await status((cb: (value: number) => void) =>
    ops.write("/from-fuse.txt", fh, payload, payload.byteLength, 0, cb),
  );
  assert.equal(written, payload.byteLength);

  // release + flush + fsync — every codepath a well-behaved
  // client would call before considering the write durable.
  assert.equal(await status((cb) => ops.flush("/from-fuse.txt", fh, cb)), 0);
  assert.equal(await status((cb) => ops.fsync("/from-fuse.txt", fh, 0, cb)), 0);
  assert.equal(await status((cb) => ops.release("/from-fuse.txt", fh, cb)), 0);

  // The VFS is the RPC surface's source of truth. Anything that
  // wasn't written here doesn't survive a pullOnce.
  const fromVfs = vfs.readFileSync("/from-fuse.txt");
  assert.equal(
    Buffer.from(fromVfs).toString("utf8"),
    "from-fuse\n",
    "FUSE writes must be flushed into the backing VFS for RPC reads to see them",
  );
});
