import { describe, expect, it } from "vitest";

import { initializeSchema } from "../schema/index.js";
import { Database } from "../storage.js";
import { SqliteTestStorage } from "../testing.js";
import { mkdir } from "./mkdir.js";
import { readdir } from "./readdir.js";
import { writeFile } from "./writeFile.js";

function freshDB(now: () => number = () => 1000) {
  const storage = new SqliteTestStorage();
  const db = new Database(storage);
  initializeSchema(db, now);
  return db;
}

describe("readdir", () => {
  it("returns an empty array for an empty directory", () => {
    const db = freshDB();
    expect(readdir(db, "/")).toEqual([]);
  });

  it("lists files and directories with dirent shape", async () => {
    const db = freshDB();
    mkdir(db, "/sub", {}, () => 0);
    await writeFile(db, "/file.txt", "x", {}, () => 0);

    const entries = readdir(db, "/");
    expect(entries).toHaveLength(2);
    expect(entries).toContainEqual({
      name: "file.txt",
      parentPath: "/",
      isFile: true,
      isDirectory: false,
    });
    expect(entries).toContainEqual({
      name: "sub",
      parentPath: "/",
      isFile: false,
      isDirectory: true,
    });
  });

  it("sorts entries by name", async () => {
    const db = freshDB();
    await writeFile(db, "/b", "", {}, () => 0);
    await writeFile(db, "/a", "", {}, () => 0);
    await writeFile(db, "/c", "", {}, () => 0);
    expect(readdir(db, "/").map((e) => e.name)).toEqual(["a", "b", "c"]);
  });

  it("uses the canonical parent path for nested directories", async () => {
    const db = freshDB();
    mkdir(db, "/a/b", { recursive: true }, () => 0);
    await writeFile(db, "/a/b/leaf.txt", "x", {}, () => 0);

    const entries = readdir(db, "/a/b");
    expect(entries).toEqual([
      { name: "leaf.txt", parentPath: "/a/b", isFile: true, isDirectory: false },
    ]);
  });

  it("canonicalizes the parentPath even when called with a non-canonical input", async () => {
    const db = freshDB();
    mkdir(db, "/a", {}, () => 0);
    await writeFile(db, "/a/x", "", {}, () => 0);
    const entries = readdir(db, "/a//.");
    expect(entries[0]).toMatchObject({ parentPath: "/a" });
  });

  it("throws ENOENT for a missing path", () => {
    const db = freshDB();
    expect(() => readdir(db, "/missing")).toThrowError(expect.objectContaining({ code: "ENOENT" }));
  });

  it("throws ENOENT when an intermediate segment is missing", () => {
    const db = freshDB();
    expect(() => readdir(db, "/no/such/path")).toThrowError(
      expect.objectContaining({ code: "ENOENT" }),
    );
  });

  it("throws ENOTDIR when called on a file", async () => {
    const db = freshDB();
    await writeFile(db, "/file.txt", "x", {}, () => 0);
    expect(() => readdir(db, "/file.txt")).toThrowError(
      expect.objectContaining({ code: "ENOTDIR" }),
    );
  });
});
