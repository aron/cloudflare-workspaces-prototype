import { describe, expect, it } from "vitest";

import { initializeSchema, ROOT_INODE } from "../schema/index.js";
import { Database } from "../storage.js";
import { SqliteTestStorage } from "../testing.js";
import { mkdir } from "./mkdir.js";
import { resolveInode } from "./resolve.js";
import { CHUNK_SIZE, writeFile } from "./writeFile.js";

function freshDB(now: () => number = () => 1000) {
  const storage = new SqliteTestStorage();
  const db = new Database(storage);
  initializeSchema(db, now);
  return db;
}

// Reassemble a file's bytes by stitching its chunk rows together. The
// real readFile lands as Task 4; this is a deliberately minimal helper
// so writeFile tests can stand alone.
function readBack(db: Database, path: string): Uint8Array {
  const node = resolveInode(db, path);
  if (node === null) throw new Error(`no such path: ${path}`);
  if (node.type !== "file") throw new Error(`not a file: ${path}`);
  const chunks = db.all<{ hash: Uint8Array; size: number }>(
    "SELECT hash, size FROM cf_vfs_chunks WHERE inode = ? ORDER BY idx",
    node.inode,
  );
  const parts: Uint8Array[] = [];
  let total = 0;
  for (const chunk of chunks) {
    const row = db.one<{ bytes: Uint8Array }>(
      "SELECT bytes FROM cf_vfs_blob_bytes WHERE hash = ?",
      chunk.hash,
    );
    if (row === undefined) throw new Error("missing blob bytes");
    parts.push(row.bytes);
    total += row.bytes.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function countBlobs(db: Database): number {
  return db.scalar<number>("SELECT COUNT(*) FROM cf_vfs_blobs") ?? 0;
}

function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(chunks[i++]);
      } else {
        controller.close();
      }
    },
  });
}

describe("writeFile", () => {
  it("writes a small string and stores one chunk", async () => {
    const db = freshDB();
    await writeFile(db, "/hello.txt", "hello fuse", {}, () => 1234);

    const bytes = readBack(db, "/hello.txt");
    expect(new TextDecoder().decode(bytes)).toBe("hello fuse");

    const chunkCount = db.scalar<number>(
      "SELECT COUNT(*) FROM cf_vfs_chunks WHERE inode = (SELECT child_inode FROM cf_vfs_dirents WHERE parent_inode = ? AND name = ?)",
      ROOT_INODE,
      "hello.txt",
    );
    expect(chunkCount).toBe(1);
  });

  it("accepts a Uint8Array", async () => {
    const db = freshDB();
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    await writeFile(db, "/data.bin", data, {}, () => 0);
    expect(Array.from(readBack(db, "/data.bin"))).toEqual([1, 2, 3, 4, 5]);
  });

  it("accepts a ReadableStream and joins its chunks", async () => {
    const db = freshDB();
    await writeFile(
      db,
      "/streamed.txt",
      streamOf(new TextEncoder().encode("hello "), new TextEncoder().encode("stream")),
      {},
      () => 0,
    );
    expect(new TextDecoder().decode(readBack(db, "/streamed.txt"))).toBe("hello stream");
  });

  it("writes an empty file (zero chunks, zero size)", async () => {
    const db = freshDB();
    await writeFile(db, "/empty", "", {}, () => 0);
    const node = resolveInode(db, "/empty");
    expect(node?.type).toBe("file");
    const chunks = db.scalar<number>(
      "SELECT COUNT(*) FROM cf_vfs_chunks WHERE inode = ?",
      node?.inode,
    );
    expect(chunks).toBe(0);
  });

  it("splits content larger than CHUNK_SIZE across multiple chunks", async () => {
    const db = freshDB();
    const oneChunk = new Uint8Array(CHUNK_SIZE);
    oneChunk.fill(0x41); // 'A'
    const trailing = new Uint8Array(100);
    trailing.fill(0x42); // 'B'
    const combined = new Uint8Array(CHUNK_SIZE + 100);
    combined.set(oneChunk, 0);
    combined.set(trailing, CHUNK_SIZE);
    await writeFile(db, "/big", combined, {}, () => 0);

    const node = resolveInode(db, "/big");
    const chunkCount = db.scalar<number>(
      "SELECT COUNT(*) FROM cf_vfs_chunks WHERE inode = ?",
      node?.inode,
    );
    expect(chunkCount).toBe(2);

    const sizes = db
      .all<{ idx: number; size: number }>(
        "SELECT idx, size FROM cf_vfs_chunks WHERE inode = ? ORDER BY idx",
        node?.inode,
      )
      .map((r) => r.size);
    expect(sizes).toEqual([CHUNK_SIZE, 100]);

    const round = readBack(db, "/big");
    expect(round.byteLength).toBe(CHUNK_SIZE + 100);
    expect(round[0]).toBe(0x41);
    expect(round[CHUNK_SIZE]).toBe(0x42);
  });

  it("dedups identical content across two paths into one blob row", async () => {
    const db = freshDB();
    await writeFile(db, "/a.txt", "shared", {}, () => 0);
    await writeFile(db, "/b.txt", "shared", {}, () => 0);
    expect(countBlobs(db)).toBe(1);
  });

  it("overwriting reuses the blob when content is unchanged", async () => {
    const db = freshDB();
    await writeFile(db, "/x.txt", "same", {}, () => 0);
    const before = countBlobs(db);
    await writeFile(db, "/x.txt", "same", {}, () => 0);
    expect(countBlobs(db)).toBe(before);
  });

  it("overwriting replaces chunk rows; old content blob remains for GC", async () => {
    const db = freshDB();
    await writeFile(db, "/x.txt", "first", {}, () => 0);
    await writeFile(db, "/x.txt", "second-version", {}, () => 0);
    expect(new TextDecoder().decode(readBack(db, "/x.txt"))).toBe("second-version");
    // Both 'first' and 'second-version' blobs still exist; GC sweeps
    // the orphan later.
    expect(countBlobs(db)).toBe(2);
  });

  it("rejects ENOENT when the parent directory is missing", async () => {
    const db = freshDB();
    await expect(writeFile(db, "/no/such/dir/file.txt", "hi", {}, () => 0)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects EISDIR when the path resolves to a directory", async () => {
    const db = freshDB();
    mkdir(db, "/d", {}, () => 0);
    await expect(writeFile(db, "/d", "x", {}, () => 0)).rejects.toMatchObject({ code: "EISDIR" });
  });

  it("honors mode and bumps rev on first write", async () => {
    const db = freshDB();
    const beforeRev = db.scalar<number>("SELECT v FROM cf_vfs_meta WHERE k = 'rev'");
    await writeFile(db, "/run.sh", "#!/bin/sh\n", { mode: 0o755 }, () => 4242);
    const node = resolveInode(db, "/run.sh");
    expect(node?.mode).toBe(0o755);
    expect(node?.mtime).toBe(4242);
    const afterRev = db.scalar<number>("SELECT v FROM cf_vfs_meta WHERE k = 'rev'");
    expect(afterRev).toBe((beforeRev ?? 0) + 1);
    const nodeRev = db.scalar<number>("SELECT rev FROM cf_vfs_nodes WHERE inode = ?", node?.inode);
    expect(nodeRev).toBe(afterRev);
  });

  it("updates mtime and rev on overwrite", async () => {
    const db = freshDB();
    await writeFile(db, "/x.txt", "v1", {}, () => 100);
    const v1 = resolveInode(db, "/x.txt");
    const v1Rev = db.scalar<number>("SELECT rev FROM cf_vfs_nodes WHERE inode = ?", v1?.inode);

    await writeFile(db, "/x.txt", "v2", {}, () => 200);
    const v2 = resolveInode(db, "/x.txt");
    expect(v2?.inode).toBe(v1?.inode); // same inode reused
    expect(v2?.mtime).toBe(200);
    const v2Rev = db.scalar<number>("SELECT rev FROM cf_vfs_nodes WHERE inode = ?", v2?.inode);
    expect((v2Rev ?? 0) > (v1Rev ?? 0)).toBe(true);
  });

  it("writes into a nested directory", async () => {
    const db = freshDB();
    mkdir(db, "/a/b", { recursive: true }, () => 0);
    await writeFile(db, "/a/b/c.txt", "nested", {}, () => 0);
    expect(new TextDecoder().decode(readBack(db, "/a/b/c.txt"))).toBe("nested");
  });
});
