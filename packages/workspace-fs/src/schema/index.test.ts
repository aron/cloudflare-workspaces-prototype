import { describe, expect, it } from "vitest";

import { Database } from "../storage.js";
import { RecordingStorage } from "../testing-recording.js";
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
});
