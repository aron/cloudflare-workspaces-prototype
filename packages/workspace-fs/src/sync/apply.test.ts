import { describe, expect, it } from "vitest";

import { readFile } from "../fs/readFile.js";
import { resolveInode } from "../fs/resolve.js";
import { withDB, withTwoDBs } from "../fs/with-db.js";
import { writeFile } from "../fs/writeFile.js";
import { applyChanges } from "./apply.js";
import { type ChangeEntry } from "./changes.js";
import { coalesceChanges } from "./coalesce.js";
import { fetchObjects } from "./fetch.js";
import { writeWatermark } from "./watermarks.js";

async function drain<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

function hex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.byteLength; i++) s += bytes[i].toString(16).padStart(2, "0");
  return s;
}

async function collectObjects(
  db: import("../storage.js").Database,
  entries: ChangeEntry[],
): Promise<Map<string, Uint8Array>> {
  const hashes: Uint8Array[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    if (e.kind !== "file") continue;
    for (const c of e.chunks) {
      const k = hex(c.hash);
      if (!seen.has(k)) {
        seen.add(k);
        hashes.push(c.hash);
      }
    }
  }
  const out = new Map<string, Uint8Array>();
  for await (const { hash, bytes } of fetchObjects(db, hashes)) {
    out.set(hex(hash), bytes);
  }
  return out;
}

describe("applyChanges", () => {
  it("converges across a mixed stream", async () => {
    await withTwoDBs(
      async (a) => {
        await writeFile(a, "/a.txt", "alpha", {}, () => 1);
        await writeFile(a, "/b.txt", "beta", {}, () => 2);
        const entries = await drain(coalesceChanges(a, 0));
        return { entries, objects: await collectObjects(a, entries) };
      },
      async (b, { entries, objects }) => {
        await applyChanges(b, entries, objects);
        expect(await readFile(b, "/a.txt", "utf8")).toBe("alpha");
        expect(await readFile(b, "/b.txt", "utf8")).toBe("beta");
      },
    );
  });

  it("advances fetchRev to the largest applied rev", async () => {
    await withTwoDBs(
      async (a) => {
        await writeFile(a, "/x.txt", "x", {}, () => 1);
        const entries = await drain(coalesceChanges(a, 0));
        return { entries, objects: await collectObjects(a, entries) };
      },
      async (b, { entries, objects }) => {
        await applyChanges(b, entries, objects, { advanceFetchRev: 5 });
        const got = await import("./watermarks.js").then((m) => m.readWatermark(b, "fetchRev"));
        expect(got).toBe(5);
      },
    );
  });

  it("does not regress fetchRev on partial replay", async () => {
    await withDB(async (db) => {
      // Pretend a previous apply pass advanced fetchRev to 10.
      writeWatermark(db, "fetchRev", 10);
      await applyChanges(db, [], new Map(), { advanceFetchRev: 3 });
      const got = await import("./watermarks.js").then((m) => m.readWatermark(db, "fetchRev"));
      // The helper takes the max of current and requested, never
      // moves backwards.
      expect(got).toBe(10);
    });
  });

  it("commits in batches capped by byte budget", async () => {
    // Force many small files; with a tiny byte budget the apply
    // path should still converge, just across more batches. We
    // verify convergence rather than batch count (batch count is
    // an implementation detail).
    await withTwoDBs(
      async (a) => {
        for (let i = 0; i < 10; i++) {
          await writeFile(a, `/f${i}.txt`, `payload ${i}`, {}, () => 100 + i);
        }
        const entries = await drain(coalesceChanges(a, 0));
        return { entries, objects: await collectObjects(a, entries) };
      },
      async (b, { entries, objects }) => {
        await applyChanges(b, entries, objects, { maxBytesPerBatch: 16 });
        for (let i = 0; i < 10; i++) {
          expect(await readFile(b, `/f${i}.txt`, "utf8")).toBe(`payload ${i}`);
        }
      },
    );
  });

  it("handles delete entries", async () => {
    await withDB(async (db) => {
      await writeFile(db, "/gone.txt", "bye", {}, () => 1);
      await applyChanges(db, [{ kind: "delete", path: "/gone.txt" }], new Map());
      expect(resolveInode(db, "/gone.txt")).toBeNull();
    });
  });
});

describe("applyChanges loopback suppression", () => {
  it("advances pushRev to currentRev when source=upstream", async () => {
    await withDB(async (db) => {
      // Pre-existing local state: a write the container already
      // pushed. pushRev sits at currentRev.
      await writeFile(db, "/local.txt", "local", {}, () => 1);
      const { currentRev, readWatermark, writeWatermark } = await import("./watermarks.js");
      writeWatermark(db, "pushRev", currentRev(db));
      const beforePushRev = readWatermark(db, "pushRev");
      expect(beforePushRev).toBeGreaterThan(0);

      // Apply an entry as if it came from upstream. The local rev
      // counter bumps (writeFile bumps rev), but the source flag
      // makes the helper advance pushRev to match \u2014 the bump
      // looks like it was already pushed.
      await applyChanges(
        db,
        [
          {
            kind: "file",
            path: "/from-upstream.txt",
            mode: 0o644,
            mtime: 2,
            size: 0,
            chunks: [],
          },
        ],
        new Map(),
        { source: "upstream" },
      );

      const afterCurrent = currentRev(db);
      const afterPushRev = readWatermark(db, "pushRev");
      // Apply bumped currentRev (the writeFile inside).
      expect(afterCurrent).toBeGreaterThan(beforePushRev);
      // pushRev caught up so the next coalesceChanges(db, pushRev)
      // sees nothing.
      expect(afterPushRev).toBe(afterCurrent);
    });
  });

  it("source=local (default) does not advance pushRev", async () => {
    await withDB(async (db) => {
      const { readWatermark } = await import("./watermarks.js");
      await applyChanges(
        db,
        [
          {
            kind: "file",
            path: "/local.txt",
            mode: 0o644,
            mtime: 1,
            size: 0,
            chunks: [],
          },
        ],
        new Map(),
      );
      expect(readWatermark(db, "pushRev")).toBe(0);
    });
  });

  it("upstream entries do not get re-pushed on the next coalesce", async () => {
    await withDB(async (db) => {
      const { coalesceChanges } = await import("./coalesce.js");
      const { currentRev, readWatermark, writeWatermark } = await import("./watermarks.js");
      // Seed pushRev at the current point.
      writeWatermark(db, "pushRev", currentRev(db));

      // Upstream sends a file. After apply, pushRev should equal
      // currentRev, so coalesceChanges(db, pushRev) is empty.
      await applyChanges(
        db,
        [
          {
            kind: "file",
            path: "/upstream.txt",
            mode: 0o644,
            mtime: 1,
            size: 0,
            chunks: [],
          },
        ],
        new Map(),
        { source: "upstream" },
      );
      const cursor = readWatermark(db, "pushRev");
      const drained = [];
      for await (const e of coalesceChanges(db, cursor)) drained.push(e);
      expect(drained).toEqual([]);
    });
  });
});

describe("applyChanges loopback suppression — F1", () => {
  // Regression for F1: when local writes are sitting at
  // rev > pushRev (i.e. queued for the next push) and an
  // upstream pull arrives, the old code advanced pushRev to
  // currentRev unconditionally. That stranded the local
  // writes — the next pushOnce skipped them as already-
  // shipped. Fix: only advance pushRev when the existing
  // value already covers everything that existed before this
  // apply.
  it("does not advance pushRev past unpushed local writes", async () => {
    await withDB(async (db) => {
      const { currentRev, readWatermark } = await import("./watermarks.js");
      // Simulate an unpushed local write: pushRev stays at
      // its initial value (1) but currentRev climbs.
      await writeFile(db, "/local.txt", new Uint8Array([1, 2, 3]), { mode: 0o644 }, () => 1);
      const revBeforeApply = currentRev(db);
      const pushRevBefore = readWatermark(db, "pushRev");
      expect(pushRevBefore).toBeLessThan(revBeforeApply);

      // Upstream sends an entry. alreadyApplied skips it
      // (we don't have it locally, so it actually writes —
      // pick a path that won't conflict).
      await applyChanges(
        db,
        [
          {
            kind: "file",
            path: "/from-upstream.txt",
            mode: 0o644,
            mtime: 2,
            size: 0,
            chunks: [],
          },
        ],
        new Map(),
        { source: "upstream" },
      );
      // pushRev must NOT have jumped past the unpushed
      // local write. The local write is at revBeforeApply;
      // we want pushRev still < revBeforeApply so the next
      // pushOnce drains it.
      const pushRevAfter = readWatermark(db, "pushRev");
      expect(pushRevAfter).toBeLessThan(revBeforeApply);
      // The local write should still appear in coalesce.
      const drained = [];
      for await (const e of coalesceChanges(db, pushRevAfter)) drained.push(e);
      const paths = drained.map((e) => (e.kind === "delete" ? e.path : e.path));
      expect(paths).toContain("/local.txt");
    });
  });

  it("still advances pushRev when caller had no unpushed locals", async () => {
    await withDB(async (db) => {
      const { currentRev, readWatermark, writeWatermark } = await import("./watermarks.js");
      // pushRev already caught up to currentRev: caller has
      // no pending local writes.
      writeWatermark(db, "pushRev", currentRev(db));
      await applyChanges(
        db,
        [
          {
            kind: "file",
            path: "/from-upstream.txt",
            mode: 0o644,
            mtime: 1,
            size: 0,
            chunks: [],
          },
        ],
        new Map(),
        { source: "upstream" },
      );
      // Loopback suppression still works in the safe case:
      // pushRev advances to cover the apply's own rev bump.
      expect(readWatermark(db, "pushRev")).toBe(currentRev(db));
    });
  });
});
