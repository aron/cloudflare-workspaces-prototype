import { describe, expect, it } from "vitest";

import { mkdir } from "../fs/mkdir.js";
import { readFile } from "../fs/readFile.js";
import { resolveInode } from "../fs/resolve.js";
import { rm } from "../fs/rm.js";
import { symlink } from "../fs/symlink.js";
import { withDB } from "../fs/with-db.js";
import { writeFile } from "../fs/writeFile.js";
import { initializeSchema } from "../schema/index.js";
import { Database } from "../storage.js";
import { SQLiteTestStorage } from "../testing.js";
import { type ChangeEntry } from "./changes.js";
import { coalesceChanges } from "./coalesce.js";
import { pushObjects } from "./push.js";

// Minimal hand-rolled apply loop. Y8 generalises this with batching
// and watermark advancement. For Y4 we just need to prove that
// coalesceChanges + pushObjects together transfer enough information
// for the receiver to converge.
async function apply(db: Database, entries: ChangeEntry[], objects: Map<string, Uint8Array>) {
  for (const entry of entries) {
    if (entry.kind === "delete") {
      try {
        rm(db, entry.path, { recursive: true, force: true });
      } catch {
        // Path may already be gone if the receiver was empty.
      }
      continue;
    }
    if (entry.kind === "dir") {
      mkdir(db, entry.path, { mode: entry.mode, recursive: true }, () => entry.mtime);
      continue;
    }
    if (entry.kind === "symlink") {
      // Best-effort: writeFile to a path the symlink replaces won't
      // round-trip through symlink. For this Y4 test we never overwrite
      // a symlink with a non-symlink, so a fresh create is fine.
      symlink(db, entry.target, entry.path, () => entry.mtime);
      continue;
    }
    // file: assemble bytes from the chunks the sender shipped.
    const parts: Uint8Array[] = [];
    for (const c of entry.chunks) {
      const key = hex(c.hash);
      const bytes = objects.get(key);
      if (bytes === undefined) throw new Error(`missing object for ${key}`);
      parts.push(bytes);
    }
    const total = parts.reduce((acc, p) => acc + p.byteLength, 0);
    const buf = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      buf.set(p, off);
      off += p.byteLength;
    }
    await writeFile(db, entry.path, buf, { mode: entry.mode }, () => entry.mtime);
  }
}

function hex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.byteLength; i++) s += bytes[i].toString(16).padStart(2, "0");
  return s;
}

async function drain<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

// Build a fresh receiver DB. Lives outside withDB because we hold two
// instances at once for the convergence test.
function freshDB(): { db: Database; close: () => void } {
  const storage = new SQLiteTestStorage();
  const db = new Database(storage);
  initializeSchema(db, () => 1);
  return { db, close: () => storage.close() };
}

describe("push", () => {
  it("transfers a single file end-to-end", async () => {
    await withDB(async (a) => {
      await writeFile(a, "/hello.txt", "hello world", { mode: 0o644 }, () => 100);

      const entries = await drain(coalesceChanges(a, 0));
      const hashes = collectHashes(entries);
      const objects = new Map<string, Uint8Array>();
      for await (const { hash, bytes } of pushObjects(a, hashes)) {
        objects.set(hex(hash), bytes);
      }

      const { db: b, close } = freshDB();
      try {
        await apply(b, entries, objects);
        // Verify convergence: b reads back what a wrote.
        const node = resolveInode(b, "/hello.txt");
        expect(node?.type).toBe("file");
        const got = await readFile(b, "/hello.txt", "utf8");
        expect(got).toBe("hello world");
      } finally {
        close();
      }
    });
  });

  it("converges across mixed mutations", async () => {
    await withDB(async (a) => {
      mkdir(a, "/d", { mode: 0o755 }, () => 1);
      await writeFile(a, "/d/a.txt", "alpha", {}, () => 2);
      await writeFile(a, "/d/b.txt", "beta", {}, () => 3);
      symlink(a, "/d/a.txt", "/link", () => 4);
      await writeFile(a, "/tmp.txt", "scratch", {}, () => 5);
      rm(a, "/tmp.txt", {});

      const entries = await drain(coalesceChanges(a, 0));
      const objects = await pull(a, collectHashes(entries));

      const { db: b, close } = freshDB();
      try {
        await apply(b, entries, objects);
        expect(await readFile(b, "/d/a.txt", "utf8")).toBe("alpha");
        expect(await readFile(b, "/d/b.txt", "utf8")).toBe("beta");
        expect(resolveInode(b, "/tmp.txt")).toBeNull();
        // /link resolves through the symlink to /d/a.txt.
        const linked = await readFile(b, "/link", "utf8");
        expect(linked).toBe("alpha");
      } finally {
        close();
      }
    });
  });

  it("pushObjects yields each requested hash exactly once", async () => {
    await withDB(async (a) => {
      await writeFile(a, "/a.txt", "same", {}, () => 1);
      await writeFile(a, "/b.txt", "same", {}, () => 2);
      const entries = await drain(coalesceChanges(a, 0));
      const hashes = collectHashes(entries);
      // Both files reuse one chunk hash; collectHashes already
      // dedups, so we should see exactly one object on the wire.
      expect(hashes).toHaveLength(1);
      const objects = await pull(a, hashes);
      expect(objects.size).toBe(1);
    });
  });
});

function collectHashes(entries: ChangeEntry[]): Uint8Array[] {
  const seen = new Set<string>();
  const out: Uint8Array[] = [];
  for (const e of entries) {
    if (e.kind !== "file") continue;
    for (const c of e.chunks) {
      const key = hex(c.hash);
      if (!seen.has(key)) {
        seen.add(key);
        out.push(c.hash);
      }
    }
  }
  return out;
}

async function pull(db: Database, hashes: Uint8Array[]): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>();
  for await (const { hash, bytes } of pushObjects(db, hashes)) {
    out.set(hex(hash), bytes);
  }
  return out;
}
