import { describe, expect, test } from "vitest";

import { createNodeVirtualFileSystem, makeFUSEOps } from "./index.js";

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
    expect(typeof ops[name]).toBe("function", `${name} should be defined`);
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
    expect(errno).toBe(ENOSYS, `${name} should return ENOSYS`);
  }
});

test("implemented FUSE ops all have explicit current expectations", async () => {
  const { vfs } = await createNodeVirtualFileSystem();
  const ops = makeFUSEOps(vfs);

  expect(await status((cb) => ops.init(cb))).toBe(0);

  expect(await status((cb) => ops.mkdir("/dir", 0o755, cb))).toBe(0);
  expect(await status((cb) => ops.access("/dir", 0, cb))).toBe(0);
  expect(await status((cb) => ops.access("/missing", 0, cb))).toBe(-2);

  const rootDir = await callback((cb) => ops.opendir("/", 0, cb));
  expect(rootDir.errno).toBe(0);
  expect(typeof rootDir.result).toBe("number");
  expect(await status((cb) => ops.releasedir("/", rootDir.result as number, cb))).toBe(0);

  const create = await callback((cb) => ops.create("/dir/file.txt", 0o644, cb));
  expect(create.errno).toBe(0);
  expect(typeof create.result).toBe("number");

  const open = await callback((cb) => ops.open("/dir/file.txt", 0, cb));
  expect(open.errno).toBe(0);
  expect(typeof open.result).toBe("number");

  const bytes = Buffer.from("hello fuse");
  expect(
    await status((cb) =>
      ops.write("/dir/file.txt", create.result as number, bytes, bytes.length, 0, cb),
    ),
  ).toBe(bytes.length);

  const readBuffer = Buffer.alloc(bytes.length);
  expect(
    await status((cb) =>
      ops.read("/dir/file.txt", create.result as number, readBuffer, readBuffer.length, 0, cb),
    ),
  ).toBe(bytes.length);
  expect(readBuffer.toString()).toBe("hello fuse");

  const dir = await callback((cb) => ops.readdir("/dir", cb));
  expect(dir.errno).toBe(0);
  expect(dir.result).toEqual(["file.txt"]);

  const stat = await callback((cb) => ops.getattr("/dir/file.txt", cb));
  expect(stat.errno).toBe(0);
  expect((stat.result as { size: number }).size).toBe(bytes.length);

  const fstat = await callback((cb) => ops.fgetattr("/dir/file.txt", create.result as number, cb));
  expect(fstat.errno).toBe(0);
  expect((fstat.result as { size: number }).size).toBe(bytes.length);

  const statfs = await callback((cb) => ops.statfs("/", cb));
  expect(statfs.errno).toBe(0);
  expect((statfs.result as { bsize: number; namemax: number }).bsize).toBe(4096);
  expect((statfs.result as { bsize: number; namemax: number }).namemax).toBe(255);

  expect(await status((cb) => ops.chmod("/dir/file.txt", 0o600, cb))).toBe(0);
  expect(await status((cb) => ops.chown("/dir/file.txt", 123, 456, cb))).toBe(0);
  expect(await status((cb) => ops.flush("/dir/file.txt", create.result as number, cb))).toBe(0);
  expect(await status((cb) => ops.fsync("/dir/file.txt", create.result as number, 0, cb))).toBe(0);
  expect(await status((cb) => ops.fsyncdir("/dir", rootDir.result as number, 0, cb))).toBe(0);

  expect(
    await status((cb) =>
      ops.setxattr("/dir/file.txt", "user.test", Buffer.from("value"), 0, 0, cb),
    ),
  ).toBe(0);
  expect(await status((cb) => ops.getxattr("/dir/file.txt", "user.test", 0, cb))).toBe(-61);
  const xattrs = await callback((cb) => ops.listxattr("/dir/file.txt", cb));
  expect(xattrs.errno).toBe(0);
  expect(Buffer.isBuffer(xattrs.result)).toBe(true);
  expect((xattrs.result as Buffer).length).toBe(0);
  expect(await status((cb) => ops.removexattr("/dir/file.txt", "user.test", cb))).toBe(-61);
  expect(await status((cb) => ops.utimens("/dir/file.txt", Date.now(), Date.now(), cb))).toBe(0);
  expect(await status((cb) => ops.utimens("/missing", Date.now(), Date.now(), cb))).toBe(-2);

  expect(await status((cb) => ops.rename("/dir/file.txt", "/dir/renamed.txt", cb))).toBe(0);
  const renamedBuf = Buffer.alloc(64);
  expect(
    await status((cb) => ops.read("/dir/renamed.txt", 0, renamedBuf, renamedBuf.length, 0, cb)),
  ).toBe(bytes.length);
  expect(renamedBuf.subarray(0, bytes.length).toString()).toBe("hello fuse");

  expect(await status((cb) => ops.truncate("/dir/renamed.txt", 5, cb))).toBe(0);
  const truncBuf = Buffer.alloc(64);
  expect(
    await status((cb) => ops.read("/dir/renamed.txt", 0, truncBuf, truncBuf.length, 0, cb)),
  ).toBe(5);
  expect(truncBuf.subarray(0, 5).toString()).toBe("hello");

  expect(
    await status((cb) => ops.ftruncate("/dir/renamed.txt", create.result as number, 2, cb)),
  ).toBe(0);
  const ftruncBuf = Buffer.alloc(64);
  expect(
    await status((cb) => ops.read("/dir/renamed.txt", 0, ftruncBuf, ftruncBuf.length, 0, cb)),
  ).toBe(2);
  expect(ftruncBuf.subarray(0, 2).toString()).toBe("he");

  expect(await status((cb) => ops.release("/dir/renamed.txt", create.result as number, cb))).toBe(
    0,
  );
  expect(await status((cb) => ops.release("/dir/renamed.txt", open.result as number, cb))).toBe(0);
  expect(await status((cb) => ops.unlink("/dir/renamed.txt", cb))).toBe(0);
  expect(vfs.readdirSync("/dir")).toEqual([]);
  expect(await status((cb) => ops.rmdir("/dir", cb))).toBe(0);
  expect(vfs.readdirSync("/")).toEqual([]);
});

test("FUSE ops return errno values instead of throwing for expected filesystem errors", async () => {
  const ops = makeFUSEOps((await createNodeVirtualFileSystem()).vfs);

  const missing = await callback((cb) => ops.getattr("/missing", cb));
  expect(missing.errno).toBe(-2);

  expect(await status((cb) => ops.open("/missing", 0, cb))).toBe(-2);
  expect(await status((cb) => ops.unlink("/missing", cb))).toBe(-2);
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
  expect(create.errno).toBe(0);
  const fh = create.result as number;

  // Sized just past the cap. The driver allocates the buffer up-front
  // and writes into it, so this also catches an off-by-one in the
  // boundary check.
  const PAST_CAP = 256 * 1024 * 1024 + 1;
  const tinyBuffer = Buffer.alloc(1, 0x61);
  const written = await status((cb: (value: number) => void) =>
    ops.write("/big", fh, tinyBuffer, 1, PAST_CAP - 1, cb),
  );
  expect(written).toBe(-27, "expected EFBIG (-27)");

  // Truncate past the cap should also refuse rather than allocate.
  const truncated = await status((cb: (value: number) => void) =>
    ops.truncate("/big", PAST_CAP, cb),
  );
  expect(truncated).toBe(-27, "expected EFBIG (-27) from truncate");
});

test("FUSE write is visible through the backing VFS after release", async () => {
  // The production wsd-container example showed FUSE-written files
  // returning HTTP 200 / 0 bytes when read back via the RPC
  // surface. makeFUSEOps keeps a per-file in-memory buffer
  // (`files` Map) that .write() updates; .release(), .flush(),
  // and .fsync() spill that buffer into the backing VFS so
  // anything reading through the VFS surface (capnweb pull,
  // host-side @platformatic/vfs consumers) sees the bytes.
  const { vfs } = await createNodeVirtualFileSystem();
  const ops = makeFUSEOps(vfs);

  const create = await callback((cb: (errno: number, result: unknown) => void) =>
    ops.create("/from-fuse.txt", 0o644, cb),
  );
  expect(create.errno).toBe(0);
  const fh = create.result as number;

  const payload = Buffer.from("from-fuse\n", "utf8");
  const written = await status((cb: (value: number) => void) =>
    ops.write("/from-fuse.txt", fh, payload, payload.byteLength, 0, cb),
  );
  expect(written).toBe(payload.byteLength);

  // release + flush + fsync — every codepath a well-behaved
  // client would call before considering the write durable.
  expect(await status((cb) => ops.flush("/from-fuse.txt", fh, cb))).toBe(0);
  expect(await status((cb) => ops.fsync("/from-fuse.txt", fh, 0, cb))).toBe(0);
  expect(await status((cb) => ops.release("/from-fuse.txt", fh, cb))).toBe(0);

  // The VFS is the RPC surface's source of truth. Anything that
  // wasn't written here doesn't survive a pullOnce.
  const fromVfs = vfs.readFileSync("/from-fuse.txt");
  expect(Buffer.from(fromVfs).toString("utf8")).toBe(
    "from-fuse\n",
    "FUSE writes must be flushed into the backing VFS for RPC reads to see them",
  );
});

test("FUSE truncate is visible through the backing VFS after fsync", async () => {
  // truncate writes only to the in-memory buffer (entry.size,
  // zero-fill via entry.buf). Without an explicit spill the VFS
  // still reports the pre-truncate size, breaking sync-side stat.
  // Pin the contract: after truncate + fsync, vfs.statSync reports
  // the truncated size and vfs.readFileSync returns the truncated
  // bytes.
  const { vfs } = await createNodeVirtualFileSystem();
  const ops = makeFUSEOps(vfs);

  // Seed a file with content.
  const create = await callback((cb: (errno: number, result: unknown) => void) =>
    ops.create("/t.txt", 0o644, cb),
  );
  expect(create.errno).toBe(0);
  const fh = create.result as number;
  const payload = Buffer.from("original-content", "utf8");
  await status((cb: (value: number) => void) =>
    ops.write("/t.txt", fh, payload, payload.byteLength, 0, cb),
  );
  expect(await status((cb) => ops.fsync("/t.txt", fh, 0, cb))).toBe(0);
  expect(vfs.statSync("/t.txt").size).toBe(payload.byteLength);

  // Shrink via truncate and re-sync.
  expect(await status((cb) => ops.truncate("/t.txt", 5, cb))).toBe(0);
  expect(await status((cb) => ops.fsync("/t.txt", fh, 0, cb))).toBe(0);

  expect(vfs.statSync("/t.txt").size).toBe(5);
  expect(Buffer.from(vfs.readFileSync("/t.txt")).toString("utf8")).toBe("origi");
});

test("FUSE rename carries the buffered bytes to the new path", async () => {
  // rename() moves the entry in the `files` Map alongside the VFS
  // rename. If only the VFS rename ran, a buffered-but-unflushed
  // write would land on the old path's empty inode (now ENOENT)
  // and the new path would read empty.
  const { vfs } = await createNodeVirtualFileSystem();
  const ops = makeFUSEOps(vfs);

  const create = await callback((cb: (errno: number, result: unknown) => void) =>
    ops.create("/old.txt", 0o644, cb),
  );
  expect(create.errno).toBe(0);
  const fh = create.result as number;
  const payload = Buffer.from("renamed-content", "utf8");
  await status((cb: (value: number) => void) =>
    ops.write("/old.txt", fh, payload, payload.byteLength, 0, cb),
  );

  // Rename before the buffer ever spills. The buffer entry moves
  // with the file; fsync on the new path spills correctly.
  expect(await status((cb) => ops.rename("/old.txt", "/new.txt", cb))).toBe(0);
  expect(await status((cb) => ops.fsync("/new.txt", fh, 0, cb))).toBe(0);

  expect(Buffer.from(vfs.readFileSync("/new.txt")).toString("utf8")).toBe("renamed-content");
  // Old path is gone from both layers.
  expect(() => vfs.statSync("/old.txt")).toThrow();
});

test("FUSE getattr size matches what readFileSync would return", async () => {
  // getattr returns entry.size when the buffer is populated, so
  // stat-after-write sees the new size even before flush. The VFS
  // sees the pre-write inode size (0). After flush they have to
  // agree, otherwise the buffer is silently masking a stale VFS
  // state that an RPC reader would hit.
  const { vfs } = await createNodeVirtualFileSystem();
  const ops = makeFUSEOps(vfs);

  const create = await callback((cb: (errno: number, result: unknown) => void) =>
    ops.create("/g.txt", 0o644, cb),
  );
  expect(create.errno).toBe(0);
  const fh = create.result as number;
  const payload = Buffer.from("twelve-bytes", "utf8");
  await status((cb: (value: number) => void) =>
    ops.write("/g.txt", fh, payload, payload.byteLength, 0, cb),
  );
  // Buffer-only state: FUSE getattr leads, VFS lags. Documents the
  // intentional window between write() and a flushing op.
  const beforeFlush = await callback((cb: (errno: number, result: unknown) => void) =>
    ops.getattr("/g.txt", cb),
  );
  expect((beforeFlush.result as { size: number }).size).toBe(12);
  expect(vfs.statSync("/g.txt").size).toBe(0);

  // After flush both must agree — anything calling stat through
  // the VFS (RPC, host-side platformatic/vfs) needs the truth.
  expect(await status((cb) => ops.fsync("/g.txt", fh, 0, cb))).toBe(0);
  const afterFlush = await callback((cb: (errno: number, result: unknown) => void) =>
    ops.getattr("/g.txt", cb),
  );
  expect((afterFlush.result as { size: number }).size).toBe(12);
  expect(vfs.statSync("/g.txt").size).toBe(12);
});

test("FUSE ops translate kernel-relative paths onto the configured mount point", async () => {
  // The kernel hands the driver paths relative to the mount root
  // (e.g. "/repo/a.txt"). With mountPoint="/workspace" each path
  // resolves under /workspace/... in the backing VFS, so capnweb
  // pulls and shell `exec` consumers see the same absolute path.
  const { vfs } = await createNodeVirtualFileSystem();
  vfs.mkdirSync("/workspace/repo", { recursive: true });
  vfs.writeFileSync("/workspace/repo/a.txt", Buffer.from("alpha"));
  const ops = makeFUSEOps(vfs, "/workspace");

  const dir = await callback((cb) => ops.readdir("/repo", cb));
  expect(dir.errno).toBe(0);
  expect(dir.result).toEqual(["a.txt"]);

  const open = await callback((cb) => ops.open("/repo/a.txt", 0, cb));
  expect(open.errno).toBe(0);
  const readBuffer = Buffer.alloc(5);
  expect(
    await status((cb) => ops.read("/repo/a.txt", open.result as number, readBuffer, 5, 0, cb)),
  ).toBe(5);
  expect(readBuffer.toString()).toBe("alpha");

  const create = await callback((cb) => ops.create("/repo/b.txt", 0o644, cb));
  expect(create.errno).toBe(0);
  const payload = Buffer.from("bravo");
  expect(
    await status((cb) =>
      ops.write("/repo/b.txt", create.result as number, payload, payload.length, 0, cb),
    ),
  ).toBe(payload.length);
  expect(await status((cb) => ops.release("/repo/b.txt", create.result as number, cb))).toBe(0);

  expect(vfs.readFileSync("/workspace/repo/b.txt").toString()).toBe("bravo");
  // The unprefixed path doesn't exist in the VFS — it would only
  // exist if the driver had skipped the mountPoint translation.
  expect(vfs.existsSync("/repo/b.txt")).toBe(false);
});

test("FUSE ops reject a relative mountPoint", async () => {
  const { vfs } = await createNodeVirtualFileSystem();
  expect(() => makeFUSEOps(vfs, "workspace")).toThrow(/absolute/);
});
