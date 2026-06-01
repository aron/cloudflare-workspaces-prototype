import { describe, expect, it } from "vitest";

import { mkdir } from "./mkdir.js";
import { stat } from "./stat.js";
import { withDB } from "./with-db.js";
import { CHUNK_SIZE, writeFile } from "./writeFile.js";

describe("stat", () => {
  it("returns root metadata", async () => {
    await withDB(
      (db) => {
        expect(stat(db, "/")).toEqual({
          name: "",
          mode: 0o755,
          mtime: 1234,
          size: 0,
          isFile: false,
          isDirectory: true,
        });
      },
      { now: () => 1234 },
    );
  });

  it("returns directory metadata with the directory name", async () => {
    await withDB((db) => {
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
  });

  it("returns file metadata with content size", async () => {
    await withDB(async (db) => {
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
  });

  it("reports zero size for an empty file", async () => {
    await withDB(async (db) => {
      await writeFile(db, "/empty", "", {}, () => 0);
      expect(stat(db, "/empty").size).toBe(0);
    });
  });

  it("sums sizes across multiple chunks", async () => {
    await withDB(async (db) => {
      const bytes = new Uint8Array(CHUNK_SIZE + 100);
      await writeFile(db, "/big", bytes, {}, () => 0);
      expect(stat(db, "/big").size).toBe(CHUNK_SIZE + 100);
    });
  });

  it("works on nested paths", async () => {
    await withDB(async (db) => {
      mkdir(db, "/a/b", { recursive: true }, () => 0);
      await writeFile(db, "/a/b/c.txt", "nested", {}, () => 0);
      expect(stat(db, "/a/b/c.txt")).toMatchObject({
        name: "c.txt",
        size: 6,
        isFile: true,
      });
    });
  });

  it("throws ENOENT for a missing path", async () => {
    await withDB((db) => {
      expect(() => stat(db, "/missing")).toThrowError(expect.objectContaining({ code: "ENOENT" }));
    });
  });

  it("throws ENOENT when an intermediate segment is missing", async () => {
    await withDB((db) => {
      expect(() => stat(db, "/no/such/path")).toThrowError(
        expect.objectContaining({ code: "ENOENT" }),
      );
    });
  });
});
