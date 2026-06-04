import { expect, test } from "vitest";

import { detectFUSEBackend } from "./index.js";

function accessFor(paths: string[]) {
  const accessible = new Set(paths);
  return async (path: string) => {
    if (!accessible.has(path)) {
      throw Object.assign(new Error(`missing ${path}`), { code: "ENOENT" });
    }
  };
}

test("detectFUSEBackend detects linux when /dev/fuse is accessible", async () => {
  expect(
    await detectFUSEBackend({
      access: accessFor(["/dev/fuse"]),
      platform: "linux",
    }),
  ).toEqual({ kind: "linux" });
});

test("detectFUSEBackend reports none on linux without /dev/fuse", async () => {
  expect(
    await detectFUSEBackend({
      access: accessFor([]),
      platform: "linux",
    }),
  ).toEqual({ kind: "none", reason: "FUSE is unavailable because /dev/fuse is not accessible" });
});

test("detectFUSEBackend detects macFUSE on macOS", async () => {
  expect(
    await detectFUSEBackend({
      access: accessFor(["/Library/Filesystems/macfuse.fs"]),
      platform: "darwin",
    }),
  ).toEqual({ kind: "macfuse" });
});

test("detectFUSEBackend honors WSD_FUSE_BACKEND", async () => {
  expect(
    await detectFUSEBackend({
      access: accessFor(["/Library/Filesystems/macfuse.fs"]),
      env: { WSD_FUSE_BACKEND: "macfuse" },
      platform: "darwin",
    }),
  ).toEqual({ kind: "macfuse" });
});

test("detectFUSEBackend reports a macOS skip reason when neither backend is installed", async () => {
  expect(
    await detectFUSEBackend({
      access: accessFor([]),
      platform: "darwin",
    }),
  ).toEqual({ kind: "none", reason: "macFUSE is not installed" });
});

test("detectFUSEBackend reports unsupported platforms", async () => {
  expect(
    await detectFUSEBackend({
      access: accessFor([]),
      platform: "win32",
    }),
  ).toEqual({ kind: "none", reason: "unsupported platform win32" });
});
