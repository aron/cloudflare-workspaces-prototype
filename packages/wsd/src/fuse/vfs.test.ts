const assert = require("node:assert/strict");
const { test } = require("node:test");

const { createNodeVirtualFileSystem } = require("../../dist/fuse/index.js");

test("createNodeVirtualFileSystem returns a @platformatic/vfs filesystem", async () => {
  const { vfs } = await createNodeVirtualFileSystem();

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

test("createNodeVirtualFileSystem pulls initial state from an upstream SyncRPC", async () => {
  const { createHash } = require("node:crypto");
  const bytes = Buffer.from("hi");
  const hash = new Uint8Array(createHash("sha256").update(bytes).digest());

  let fetchChangesCalls = 0;
  const upstream = {
    async fetchChanges() {
      fetchChangesCalls++;
      return new ReadableStream({
        start(c) {
          c.enqueue({
            kind: "file",
            path: "/hi.txt",
            mode: 0o644,
            mtime: 100,
            size: 2,
            chunks: [{ hash, size: 2 }],
          });
          c.close();
        },
      });
    },
    async hasObjects() {
      return [];
    },
    async fetchObjects(hashes) {
      return new ReadableStream({
        start(c) {
          for (const h of hashes) c.enqueue({ hash: h, bytes });
          c.close();
        },
      });
    },
    async push() {
      return { rev: 0, appliedPushRev: 0 };
    },
    async pushObjects() {},
  };

  const { vfs } = await createNodeVirtualFileSystem({ upstream });
  assert.equal(fetchChangesCalls, 1);
  assert.equal(vfs.readFileSync("/hi.txt").toString(), "hi");
});
