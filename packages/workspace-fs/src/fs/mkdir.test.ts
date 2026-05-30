import { describe, expect, it } from "vitest";

import { initializeSchema, ROOT_INODE } from "../schema/index.js";
import { Database } from "../storage.js";
import { SqliteTestStorage } from "../testing.js";
import { mkdir } from "./mkdir.js";
import { resolveInode } from "./resolve.js";

function freshDB(now: () => number = () => 1000) {
  const storage = new SqliteTestStorage();
  const db = new Database(storage);
  initializeSchema(db, now);
  return db;
}

describe("mkdir", () => {
  it("creates a top-level directory with the default mode", () => {
    const db = freshDB();
    mkdir(db, "/a", {}, () => 2000);

    const resolved = resolveInode(db, "/a");
    expect(resolved).toMatchObject({ type: "dir", mode: 0o755, mtime: 2000 });
  });

  it("honors the supplied mode", () => {
    const db = freshDB();
    mkdir(db, "/locked", { mode: 0o700 }, () => 0);
    expect(resolveInode(db, "/locked")?.mode).toBe(0o700);
  });

  it("bumps rev and stamps it onto the new node", () => {
    const db = freshDB();
    const beforeRev = db.scalar<number>("SELECT v FROM cf_vfs_meta WHERE k = 'rev'");
    mkdir(db, "/a", {}, () => 0);
    const afterRev = db.scalar<number>("SELECT v FROM cf_vfs_meta WHERE k = 'rev'");
    expect(afterRev).toBe((beforeRev ?? 0) + 1);

    const nodeRev = db.scalar<number>(
      "SELECT n.rev FROM cf_vfs_nodes n JOIN cf_vfs_dirents d ON d.child_inode = n.inode WHERE d.parent_inode = ? AND d.name = ?",
      ROOT_INODE,
      "a",
    );
    expect(nodeRev).toBe(afterRev);
  });

  it("rejects when the parent directory is missing", () => {
    const db = freshDB();
    expect(() => mkdir(db, "/no/such/parent", {}, () => 0)).toThrowError(
      expect.objectContaining({ code: "ENOENT" }),
    );
  });

  it("rejects when the parent path segment is a file (ENOTDIR)", () => {
    const db = freshDB();
    // Plant a file at /a directly so /a/b's parent resolves to a file.
    db.run("INSERT INTO cf_vfs_nodes (type, mode, mtime, rev) VALUES ('file', 420, 0, 0)");
    const inode = db.scalar<number>("SELECT last_insert_rowid()");
    db.run(
      "INSERT INTO cf_vfs_dirents (parent_inode, name, child_inode) VALUES (?, ?, ?)",
      ROOT_INODE,
      "a",
      inode,
    );
    expect(() => mkdir(db, "/a/b", {}, () => 0)).toThrowError(
      expect.objectContaining({ code: "ENOTDIR" }),
    );
  });

  it("rejects EEXIST when the path already exists as a directory without recursive", () => {
    const db = freshDB();
    mkdir(db, "/a", {}, () => 0);
    expect(() => mkdir(db, "/a", {}, () => 0)).toThrowError(
      expect.objectContaining({ code: "EEXIST" }),
    );
  });

  it("rejects EEXIST when the path already exists as a file", () => {
    const db = freshDB();
    db.run("INSERT INTO cf_vfs_nodes (type, mode, mtime, rev) VALUES ('file', 420, 0, 0)");
    const inode = db.scalar<number>("SELECT last_insert_rowid()");
    db.run(
      "INSERT INTO cf_vfs_dirents (parent_inode, name, child_inode) VALUES (?, ?, ?)",
      ROOT_INODE,
      "a",
      inode,
    );
    expect(() => mkdir(db, "/a", {}, () => 0)).toThrowError(
      expect.objectContaining({ code: "EEXIST" }),
    );
  });

  it("recursive: creates missing ancestors", () => {
    const db = freshDB();
    mkdir(db, "/x/y/z", { recursive: true }, () => 1234);
    expect(resolveInode(db, "/x")?.type).toBe("dir");
    expect(resolveInode(db, "/x/y")?.type).toBe("dir");
    expect(resolveInode(db, "/x/y/z")?.type).toBe("dir");
  });

  it("recursive: is idempotent when the target already exists as a dir", () => {
    const db = freshDB();
    mkdir(db, "/a/b", { recursive: true }, () => 0);
    expect(() => mkdir(db, "/a/b", { recursive: true }, () => 0)).not.toThrow();
  });

  it("recursive: still rejects EEXIST when the target exists as a file", () => {
    const db = freshDB();
    mkdir(db, "/a", {}, () => 0);
    db.run("INSERT INTO cf_vfs_nodes (type, mode, mtime, rev) VALUES ('file', 420, 0, 0)");
    const inode = db.scalar<number>("SELECT last_insert_rowid()");
    const aInode = resolveInode(db, "/a")?.inode;
    db.run(
      "INSERT INTO cf_vfs_dirents (parent_inode, name, child_inode) VALUES (?, ?, ?)",
      aInode,
      "b",
      inode,
    );
    expect(() => mkdir(db, "/a/b", { recursive: true }, () => 0)).toThrowError(
      expect.objectContaining({ code: "EEXIST" }),
    );
  });

  it("rejects EEXIST when creating root", () => {
    const db = freshDB();
    expect(() => mkdir(db, "/", {}, () => 0)).toThrowError(
      expect.objectContaining({ code: "EEXIST" }),
    );
  });
});
