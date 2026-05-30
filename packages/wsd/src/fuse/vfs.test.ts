const assert = require("node:assert/strict");
const { test } = require("node:test");

const { createNodeVirtualFileSystem } = require("../../dist/fuse/index.js");

test("createNodeVirtualFileSystem returns a @platformatic/vfs filesystem", () => {
  const vfs = createNodeVirtualFileSystem();

  vfs.mkdirSync("/project", { recursive: true });
  vfs.writeFileSync("/project/hello.txt", Buffer.from("hello"));

  assert.deepEqual(vfs.readdirSync("/"), ["project"]);
  assert.deepEqual(vfs.readdirSync("/project"), ["hello.txt"]);
  assert.equal(vfs.readFileSync("/project/hello.txt").toString(), "hello");

  vfs.renameSync("/project/hello.txt", "/project/greeting.txt");
  assert.equal(vfs.existsSync("/project/hello.txt"), false);
  assert.equal(vfs.readFileSync("/project/greeting.txt").toString(), "hello");

  vfs.unlinkSync("/project/greeting.txt");
  assert.deepEqual(vfs.readdirSync("/project"), []);
});
