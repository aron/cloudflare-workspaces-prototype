import { describe, expect, it } from "vitest";

import { createWorkspaceFilesystem } from "../index.js";
import { RecordingStorage } from "../testing-recording.js";

describe("createWorkspaceFilesystem", () => {
  it("lazily initializes the documented schema on first use", async () => {
    const storage = new RecordingStorage();
    const fs = createWorkspaceFilesystem(storage, { now: () => 1234 });

    await expect(fs.stat("/")).rejects.toMatchObject({ code: "EIO" });

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

  it("rejects a newer on-disk schema version", async () => {
    const storage = new RecordingStorage({ schemaVersion: 999 });
    const fs = createWorkspaceFilesystem(storage);

    await expect(fs.stat("/")).rejects.toMatchObject({ code: "EIO" });
    await expect(fs.stat("/")).rejects.toThrow(
      /Unsupported workspace filesystem schema version 999/,
    );
  });
});
