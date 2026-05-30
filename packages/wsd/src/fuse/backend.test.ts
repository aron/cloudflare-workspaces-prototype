const assert = require("node:assert/strict");
const { test } = require("node:test");

const { detectFUSEBackend } = require("../../dist/fuse/index.js");

function accessFor(paths: string[]) {
  const accessible = new Set(paths);
  return async (path: string) => {
    if (!accessible.has(path)) {
      throw Object.assign(new Error(`missing ${path}`), { code: "ENOENT" });
    }
  };
}

test("detectFUSEBackend detects linux when /dev/fuse is accessible", async () => {
  assert.deepEqual(await detectFUSEBackend({
    access: accessFor(["/dev/fuse"]),
    platform: "linux",
  }), { kind: "linux" });
});

test("detectFUSEBackend reports none on linux without /dev/fuse", async () => {
  assert.deepEqual(await detectFUSEBackend({
    access: accessFor([]),
    platform: "linux",
  }), { kind: "none", reason: "FUSE is unavailable because /dev/fuse is not accessible" });
});

test("detectFUSEBackend prefers FUSE-T over macFUSE on macOS", async () => {
  assert.deepEqual(await detectFUSEBackend({
    access: accessFor([
      "/Library/Filesystems/fuse-t.fs",
      "/Library/Filesystems/macfuse.fs",
      "/opt/homebrew/lib",
    ]),
    arch: "arm64",
    platform: "darwin",
  }), { kind: "fuse-t", dylibDir: "/opt/homebrew/lib" });
});

test("detectFUSEBackend detects FUSE-T installed under /Library/Application Support", async () => {
  assert.deepEqual(await detectFUSEBackend({
    access: accessFor(["/Library/Application Support/fuse-t/lib"]),
    arch: "arm64",
    platform: "darwin",
  }), { kind: "fuse-t", dylibDir: "/Library/Application Support/fuse-t/lib" });
});

test("detectFUSEBackend falls back to macFUSE on macOS", async () => {
  assert.deepEqual(await detectFUSEBackend({
    access: accessFor(["/Library/Filesystems/macfuse.fs"]),
    platform: "darwin",
  }), { kind: "macfuse" });
});

test("detectFUSEBackend honors WSD_FUSE_BACKEND", async () => {
  assert.deepEqual(await detectFUSEBackend({
    access: accessFor([
      "/Library/Filesystems/fuse-t.fs",
      "/Library/Filesystems/macfuse.fs",
      "/usr/local/lib",
    ]),
    arch: "x64",
    env: { WSD_FUSE_BACKEND: "macfuse" },
    platform: "darwin",
  }), { kind: "macfuse" });
});

test("detectFUSEBackend reports a macOS skip reason when neither backend is installed", async () => {
  assert.deepEqual(await detectFUSEBackend({
    access: accessFor([]),
    platform: "darwin",
  }), { kind: "none", reason: "install FUSE-T (recommended) or macFUSE" });
});

test("detectFUSEBackend reports unsupported platforms", async () => {
  assert.deepEqual(await detectFUSEBackend({
    access: accessFor([]),
    platform: "win32",
  }), { kind: "none", reason: "unsupported platform win32" });
});
