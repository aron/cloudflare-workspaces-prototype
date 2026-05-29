const assert = require("node:assert/strict");
const { test } = require("node:test");

const { makeFuseOps } = require("../dist/fuse/driver.js");
const { MemoryVfs } = require("../dist/fuse/vfs.js");

const callback = (fn) => new Promise((resolve) => fn((errno, result) => resolve({ errno, result })));
const status = (fn) => new Promise((resolve) => fn((value) => resolve(value)));

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

  assert.equal(await status((cb) => ops.rename("/dir/file.txt", "/dir/renamed.txt", cb)), 0);
  assert.equal(vfs.readFile("/dir/renamed.txt").toString(), "hello fuse");

  assert.equal(await status((cb) => ops.truncate("/dir/renamed.txt", 5, cb)), 0);
  assert.equal(vfs.readFile("/dir/renamed.txt").toString(), "hello");

  assert.equal(await status((cb) => ops.unlink("/dir/renamed.txt", cb)), 0);
  assert.deepEqual(vfs.readdir("/dir"), []);
});

test("FUSE ops return errno values instead of throwing", async () => {
  const ops = makeFuseOps(new MemoryVfs());

  const missing = await callback((cb) => ops.getattr("/missing", cb));
  assert.equal(missing.errno, -2);

  assert.equal(await status((cb) => ops.open("/missing", 0, cb)), -2);
  assert.equal(await status((cb) => ops.unlink("/missing", cb)), -2);
});
