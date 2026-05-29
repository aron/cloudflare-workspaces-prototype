const assert = require("node:assert/strict");
const { test } = require("node:test");

const { MemoryVfs } = require("../dist/fuse/vfs.js");

test("MemoryVfs supports directory and file operations", () => {
  const vfs = new MemoryVfs();

  vfs.mkdir("/project");
  vfs.writeFile("/project/hello.txt", Buffer.from("hello"), 0o100644);

  assert.deepEqual(vfs.readdir("/"), ["project"]);
  assert.deepEqual(vfs.readdir("/project"), ["hello.txt"]);
  assert.equal(vfs.readFile("/project/hello.txt").toString(), "hello");

  vfs.write("/project/hello.txt", Buffer.from(" world"), 5);
  assert.equal(vfs.readFile("/project/hello.txt").toString(), "hello world");

  vfs.truncate("/project/hello.txt", 5);
  assert.equal(vfs.readFile("/project/hello.txt").toString(), "hello");

  vfs.rename("/project/hello.txt", "/project/greeting.txt");
  assert.equal(vfs.exists("/project/hello.txt"), false);
  assert.equal(vfs.readFile("/project/greeting.txt").toString(), "hello");

  vfs.unlink("/project/greeting.txt");
  assert.deepEqual(vfs.readdir("/project"), []);
});

test("MemoryVfs rejects paths that escape the root", () => {
  const vfs = new MemoryVfs();

  assert.throws(() => vfs.mkdir("../outside"), /absolute/);
  assert.throws(() => vfs.mkdir("/../outside"), /escape/);
  assert.throws(() => vfs.writeFile("/ok/../../outside", Buffer.alloc(0)), /escape/);
});

test("MemoryVfs updates file metadata after writes and truncates", async () => {
  const vfs = new MemoryVfs();
  vfs.writeFile("/file.txt", Buffer.from("abc"));
  const first = vfs.get("/file.txt");
  assert.equal(first.type, "file");
  assert.equal(first.size, 3);

  await new Promise((resolve) => setTimeout(resolve, 2));
  vfs.write("/file.txt", Buffer.from("d"), 3);
  const second = vfs.get("/file.txt");
  assert.equal(second.size, 4);
  assert.ok(second.mtimeMs >= first.mtimeMs);

  await new Promise((resolve) => setTimeout(resolve, 2));
  vfs.truncate("/file.txt", 1);
  const third = vfs.get("/file.txt");
  assert.equal(third.size, 1);
  assert.ok(third.mtimeMs >= second.mtimeMs);
});
