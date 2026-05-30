import { describe, expect, it } from "vitest";

import { initializeSchema } from "../schema/index.js";
import { Database } from "../storage.js";
import { SqliteTestStorage } from "../testing.js";
import { mkdir } from "./mkdir.js";
import { readFile } from "./readFile.js";
import { CHUNK_SIZE, writeFile } from "./writeFile.js";

function freshDB(now: () => number = () => 1000) {
  const storage = new SqliteTestStorage();
  const db = new Database(storage);
  initializeSchema(db, now);
  return db;
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value !== undefined) {
      parts.push(value);
      total += value.byteLength;
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

describe("readFile", () => {
  it("returns a ReadableStream by default", async () => {
    const db = freshDB();
    await writeFile(db, "/a.txt", "hello workspace", {}, () => 0);
    const stream = await readFile(db, "/a.txt");
    expect(stream).toBeInstanceOf(ReadableStream);
    expect(new TextDecoder().decode(await drain(stream))).toBe("hello workspace");
  });

  // The utf8 / string overloads live at a higher layer; this module
  // only deals in streams.

  it("streams a multi-chunk file in chunk-sized pieces", async () => {
    const db = freshDB();
    const bytes = new Uint8Array(CHUNK_SIZE + 100);
    bytes.fill(0x41);
    for (let i = CHUNK_SIZE; i < bytes.byteLength; i++) bytes[i] = 0x42;
    await writeFile(db, "/big", bytes, {}, () => 0);

    const stream = await readFile(db, "/big");
    const reader = stream.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(first.value?.byteLength).toBe(CHUNK_SIZE);
    expect(first.value?.[0]).toBe(0x41);
    const second = await reader.read();
    expect(second.done).toBe(false);
    expect(second.value?.byteLength).toBe(100);
    expect(second.value?.[0]).toBe(0x42);
    const end = await reader.read();
    expect(end.done).toBe(true);
  });

  it("returns an empty stream for an empty file", async () => {
    const db = freshDB();
    await writeFile(db, "/empty", "", {}, () => 0);
    const stream = await readFile(db, "/empty");
    const bytes = await drain(stream);
    expect(bytes.byteLength).toBe(0);
  });

  it("touches cf_vfs_blobs.last_seen when chunks are read", async () => {
    const db = freshDB();
    await writeFile(db, "/x.txt", "content", {}, () => 100);
    const before = db.scalar<number>("SELECT last_seen FROM cf_vfs_blobs");
    expect(before).toBe(100);
    const stream = await readFile(db, "/x.txt", () => 200);
    await drain(stream);
    const after = db.scalar<number>("SELECT last_seen FROM cf_vfs_blobs");
    expect(after).toBe(200);
  });

  it("rejects ENOENT when the path does not exist", async () => {
    const db = freshDB();
    await expect(readFile(db, "/missing")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects EISDIR when the path is a directory", async () => {
    const db = freshDB();
    mkdir(db, "/d", {}, () => 0);
    await expect(readFile(db, "/d")).rejects.toMatchObject({ code: "EISDIR" });
  });

  it("rejects ENOENT when an intermediate segment is missing", async () => {
    const db = freshDB();
    await expect(readFile(db, "/no/such/file")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
