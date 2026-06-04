import { SQLiteTestStorage } from "@cloudflare/dofs/testing";
import { describe, expect, it } from "vitest";

import { Database } from "../storage.js";
import { RecordingStorage } from "../testing-recording.js";
import { SCHEMA_VERSION } from "./core.js";
import { initializeSchema } from "./index.js";

describe("initializeSchema", () => {
  it("lazily initializes the documented schema on first use", () => {
    const storage = new RecordingStorage();
    const db = new Database(storage);

    initializeSchema(db, () => 1234);

    const executed = storage.statements.map((statement) => statement.query);
    expect(executed).toEqual(
      expect.arrayContaining([
        expect.stringContaining("CREATE TABLE IF NOT EXISTS vfs_meta"),
        expect.stringContaining("CREATE TABLE IF NOT EXISTS vfs_nodes"),
        expect.stringContaining("CREATE TABLE IF NOT EXISTS vfs_dirents"),
        expect.stringContaining("CREATE TABLE IF NOT EXISTS vfs_blobs"),
        expect.stringContaining("CREATE TABLE IF NOT EXISTS vfs_blob_bytes"),
        expect.stringContaining("CREATE TABLE IF NOT EXISTS vfs_chunks"),
        expect.stringContaining("CREATE TABLE IF NOT EXISTS vfs_manifests"),
        expect.stringContaining("CREATE TABLE IF NOT EXISTS vfs_changes"),
        expect.stringContaining("CREATE TABLE IF NOT EXISTS _vfs_watermark"),
        expect.stringContaining("CREATE TABLE IF NOT EXISTS _vfs_mounts"),
      ]),
    );
    expect(storage.statements).toContainEqual(
      expect.objectContaining({
        query: expect.stringContaining("INSERT OR IGNORE INTO vfs_nodes"),
        bindings: [1, 493, 1234],
      }),
    );
  });

  it("rejects a newer on-disk schema version", () => {
    const storage = new RecordingStorage({ schemaVersion: 999 });
    const db = new Database(storage);

    expect(() => initializeSchema(db, () => 0)).toThrow(
      /Unsupported workspace filesystem schema version 999/,
    );
  });

  it("stamps the current SCHEMA_VERSION in vfs_meta on a fresh DB", () => {
    const storage = new SQLiteTestStorage();
    const db = new Database(storage);

    initializeSchema(db, () => 0);

    const row = db.one<{ v: number }>("SELECT v FROM vfs_meta WHERE k = ?", "schema_version");
    expect(row?.v).toBe(SCHEMA_VERSION);
  });

  it("creates _vfs_mounts.mode on a fresh DB with the default and CHECK", () => {
    const storage = new SQLiteTestStorage();
    const db = new Database(storage);

    initializeSchema(db, () => 0);

    // Defaults to read-only when the column is omitted.
    db.run("INSERT INTO _vfs_mounts (root, kind) VALUES (?, ?)", "/m1", "r2");
    const row = db.one<{ mode: string }>("SELECT mode FROM _vfs_mounts WHERE root = ?", "/m1");
    expect(row?.mode).toBe("read-only");

    // Explicit read-write is accepted.
    db.run(
      "INSERT INTO _vfs_mounts (root, kind, mode) VALUES (?, ?, ?)",
      "/m2",
      "r2",
      "read-write",
    );
    const row2 = db.one<{ mode: string }>("SELECT mode FROM _vfs_mounts WHERE root = ?", "/m2");
    expect(row2?.mode).toBe("read-write");

    // The CHECK constraint rejects anything else.
    expect(() =>
      db.run("INSERT INTO _vfs_mounts (root, kind, mode) VALUES (?, ?, ?)", "/m3", "r2", "bogus"),
    ).toThrow(/CHECK constraint/);
  });

  it("upgrades a v1 database to the current SCHEMA_VERSION", () => {
    // Stage a database at the old shape: _vfs_mounts without the
    // mode column, vfs_meta.schema_version = 1. The baseline DDL
    // run by initializeSchema is "IF NOT EXISTS" so it won't touch
    // the existing _vfs_mounts; the migration must.
    const storage = new SQLiteTestStorage();
    const db = new Database(storage);

    db.transactionSync(() => {
      db.run(
        `CREATE TABLE vfs_meta (
          k TEXT PRIMARY KEY,
          v INTEGER NOT NULL
        )`,
      );
      db.run(
        `CREATE TABLE _vfs_mounts (
          root    TEXT PRIMARY KEY,
          kind    TEXT NOT NULL,
          indexed INTEGER NOT NULL DEFAULT 0
        )`,
      );
      db.run("INSERT INTO _vfs_mounts (root, kind, indexed) VALUES (?, ?, ?)", "/m1", "r2", 1);
      db.run("INSERT INTO vfs_meta (k, v) VALUES (?, ?)", "schema_version", 1);
    });

    initializeSchema(db, () => 0);

    // Version bumped.
    const versionRow = db.one<{ v: number }>(
      "SELECT v FROM vfs_meta WHERE k = ?",
      "schema_version",
    );
    expect(versionRow?.v).toBe(SCHEMA_VERSION);

    // Existing row preserved and stamped with the conservative
    // default so a re-index pass has to opt back into read-write.
    const row = db.one<{ root: string; mode: string; indexed: number }>(
      "SELECT root, mode, indexed FROM _vfs_mounts WHERE root = ?",
      "/m1",
    );
    expect(row).toEqual({ root: "/m1", mode: "read-only", indexed: 1 });

    // Post-migration the CHECK constraint is live.
    expect(() =>
      db.run("INSERT INTO _vfs_mounts (root, kind, mode) VALUES (?, ?, ?)", "/m2", "r2", "bogus"),
    ).toThrow(/CHECK constraint/);
  });

  it("is idempotent across repeat calls", () => {
    const storage = new SQLiteTestStorage();
    const db = new Database(storage);

    initializeSchema(db, () => 0);
    expect(() => initializeSchema(db, () => 0)).not.toThrow();

    const row = db.one<{ v: number }>("SELECT v FROM vfs_meta WHERE k = ?", "schema_version");
    expect(row?.v).toBe(SCHEMA_VERSION);
  });
});
