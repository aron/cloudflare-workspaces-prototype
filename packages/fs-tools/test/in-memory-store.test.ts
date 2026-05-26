import { describe, expect, it } from "vitest";
import { InMemoryFileStore } from "../src/stores/in-memory.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

async function collect(stream: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let total = 0;
  for await (const c of stream) {
    parts.push(c);
    total += c.length;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

describe("InMemoryFileStore", () => {
  it("returns null stat for missing files", async () => {
    const store = new InMemoryFileStore();
    expect(await store.stat("/missing")).toBeNull();
  });

  it("round-trips a write then stat then readAll", async () => {
    const store = new InMemoryFileStore();
    await store.write("/a.txt", enc.encode("hello"));
    const s = await store.stat("/a.txt");
    expect(s).toEqual({ size: 5, mtime: expect.any(Number), mode: 0o100644 });
    const buf = await store.readAll("/a.txt");
    expect(buf && dec.decode(buf)).toBe("hello");
  });

  it("readAll returns null for missing files", async () => {
    const store = new InMemoryFileStore();
    expect(await store.readAll("/nope")).toBeNull();
  });

  it("readChunks yields the full file when no range is given", async () => {
    const store = new InMemoryFileStore();
    await store.write("/big.txt", enc.encode("abcdefghij"));
    const out = await collect(store.readChunks("/big.txt"));
    expect(dec.decode(out)).toBe("abcdefghij");
  });

  it("readChunks honors byteOffset and byteLength", async () => {
    const store = new InMemoryFileStore({ chunkSize: 3 });
    await store.write("/big.txt", enc.encode("abcdefghij"));
    const out = await collect(store.readChunks("/big.txt", 2, 5));
    expect(dec.decode(out)).toBe("cdefg");
  });

  it("readChunks yields multiple chunks for files larger than chunkSize", async () => {
    const store = new InMemoryFileStore({ chunkSize: 4 });
    await store.write("/big.txt", enc.encode("abcdefghij"));
    const chunks: Uint8Array[] = [];
    for await (const c of store.readChunks("/big.txt")) chunks.push(c);
    expect(chunks.length).toBeGreaterThan(1);
    const joined = chunks.map(c => dec.decode(c)).join("");
    expect(joined).toBe("abcdefghij");
  });

  it("readChunks throws for missing files", async () => {
    const store = new InMemoryFileStore();
    await expect(collect(store.readChunks("/nope"))).rejects.toThrow(/not found/i);
  });

  it("write overwrites existing files", async () => {
    const store = new InMemoryFileStore();
    await store.write("/a", enc.encode("first"));
    await store.write("/a", enc.encode("second-longer"));
    const buf = await store.readAll("/a");
    expect(buf && dec.decode(buf)).toBe("second-longer");
  });
});
