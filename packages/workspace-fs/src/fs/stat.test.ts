import { describe, expect, it } from "vitest";

import { initializeSchema } from "../schema/index.js";
import { Database } from "../storage.js";
import { SqliteTestStorage } from "../testing.js";
import { mkdir } from "./mkdir.js";
import { stat } from "./stat.js";
import { CHUNK_SIZE, writeFile } from "./writeFile.js";

function freshDB(now: () => number = () => 1000) {
  const storage = new SqliteTestStorage();
  const db = new Database(storage);
  initializeSchema(db, now);
  return db;
}

describe("stat", () => {
  it("returns root metadata", () => {
    const db = freshDB(() => 1234);
    const s = stat(db, "/");
    expect(s).toEqual({
      name: "",
      mode: 0o755,
      mtime: 1234,
      size: 0,
      isFile: false,
      isDirectory: true,
    });
  });

  it("returns directory metadata with the directory name", () => {
    const db = freshDB();
    mkdir(db, "/dir", { mode: 0o750 }, () => 4242);
    expect(stat(db, "/dir")).toEqual({
      name: "dir",
      mode: 0o750,
      mtime: 4242,
      size: 0,
      isFile: false,
      isDirectory: true,
    });
  });

  it("returns file metadata with content size", async () => {
    const db = freshDB();
    await writeFile(db, "/hello.txt", "hello fuse", { mode: 0o600 }, () => 9999);
    expect(stat(db, "/hello.txt")).toEqual({
      name: "hello.txt",
      mode: 0o600,
      mtime: 9999,
      size: 10,
      isFile: true,
      isDirectory: false,
    });
  });

  it("reports zero size for an empty file", async () => {
    const db = freshDB();
    await writeFile(db, "/empty", "", {}, () => 0);
    expect(stat(db, "/empty").size).toBe(0);
  });

  it("sums sizes across multiple chunks", async () => {
    const db = freshDB();
    const bytes = new Uint8Array(CHUNK_SIZE + 100);
    await writeFile(db, "/big", bytes, {}, () => 0);
    expect(stat(db, "/big").size).toBe(CHUNK_SIZE + 100);
  });

  it("works on nested paths", async () => {
    const db = freshDB();
    mkdir(db, "/a/b", { recursive: true }, () => 0);
    await writeFile(db, "/a/b/c.txt", "nested", {}, () => 0);
    expect(stat(db, "/a/b/c.txt")).toMatchObject({
      name: "c.txt",
      size: 6,
      isFile: true,
    });
  });

  it("throws ENOENT for a missing path", () => {
    const db = freshDB();
    expect(() => stat(db, "/missing")).toThrowError(expect.objectContaining({ code: "ENOENT" }));
  });

  it("throws ENOENT when an intermediate segment is missing", () => {
    const db = freshDB();
    expect(() => stat(db, "/no/such/path")).toThrowError(
      expect.objectContaining({ code: "ENOENT" }),
    );
  });
});
