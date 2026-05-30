import { describe, expect, it } from "vitest";

import { incrementRev } from "./rev.js";
import { initializeSchema } from "./schema/index.js";
import { Database } from "./storage.js";
import { SqliteTestStorage } from "./testing.js";

function freshDB() {
  const storage = new SqliteTestStorage();
  const db = new Database(storage);
  initializeSchema(db, () => 0);
  return db;
}

describe("incrementRev", () => {
  it("returns the new rev value and persists it to cf_vfs_meta", () => {
    const db = freshDB();
    // initializeSchema seeds rev = 1.
    const next = incrementRev(db);
    expect(next).toBe(2);

    const stored = db.scalar<number>("SELECT v FROM cf_vfs_meta WHERE k = ?", "rev");
    expect(stored).toBe(2);
  });

  it("issues monotonically increasing revs inside a single transaction", () => {
    const db = freshDB();
    let a: number | undefined;
    let b: number | undefined;
    db.transactionSync(() => {
      a = incrementRev(db);
      b = incrementRev(db);
    });
    expect(a).toBe(2);
    expect(b).toBe(3);
    const stored = db.scalar<number>("SELECT v FROM cf_vfs_meta WHERE k = ?", "rev");
    expect(stored).toBe(3);
  });

  it("rolls back if the surrounding transaction aborts", () => {
    const db = freshDB();
    expect(() => {
      db.transactionSync(() => {
        incrementRev(db);
        throw new Error("abort");
      });
    }).toThrow("abort");
    const stored = db.scalar<number>("SELECT v FROM cf_vfs_meta WHERE k = ?", "rev");
    expect(stored).toBe(1);
  });
});
