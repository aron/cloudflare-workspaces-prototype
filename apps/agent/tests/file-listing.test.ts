/**
 * Pure-function tests for buildListing — turns a VFS snapshot into a
 * sorted, prefix-filtered, capped listing for path autocomplete.
 *
 * The real Workspace.vfs.snapshot() shape carries more than we need
 * here; the helper accepts the minimal Entry shape so tests don't have
 * to construct a full VFS.
 */
import { describe, it, expect } from "vitest";
import { buildListing, type ListingEntry } from "../src/file-listing.js";

const ENTRIES: ListingEntry[] = [
  { path: "/workspace/src", type: "dir" },
  { path: "/workspace/src/agent.ts", type: "file" },
  { path: "/workspace/src/index.ts", type: "file" },
  { path: "/workspace/skills", type: "dir" },
  { path: "/workspace/skills/foo.md", type: "file" },
  { path: "/workspace/README.md", type: "file" },
  { path: "/workspace/system.log", type: "file" },
  { path: "/tmp", type: "dir" },
];

describe("buildListing", () => {
  it("filters by prefix and sorts dirs before files, then alphabetically", () => {
    const out = buildListing(ENTRIES, "/workspace/s", 20);
    expect(out.entries.map((e) => e.path)).toEqual([
      "/workspace/skills",
      "/workspace/src",
      "/workspace/skills/foo.md",
      "/workspace/src/agent.ts",
      "/workspace/src/index.ts",
      "/workspace/system.log",
    ]);
  });

  it("returns an empty list when the prefix matches nothing", () => {
    expect(buildListing(ENTRIES, "/nowhere/", 20).entries).toEqual([]);
  });

  it("honours the limit", () => {
    const out = buildListing(ENTRIES, "/workspace/", 3);
    expect(out.entries).toHaveLength(3);
  });

  it("returns the prefix's own match when it equals an entry", () => {
    const out = buildListing(ENTRIES, "/workspace/README.md", 10);
    expect(out.entries.map((e) => e.path)).toEqual(["/workspace/README.md"]);
  });

  it("empty prefix returns everything sorted", () => {
    const out = buildListing(ENTRIES, "", 100);
    // Dirs first (alphabetical), then files (alphabetical).
    expect(out.entries.map((e) => e.path)).toEqual([
      "/tmp",
      "/workspace/skills",
      "/workspace/src",
      "/workspace/README.md",
      "/workspace/skills/foo.md",
      "/workspace/src/agent.ts",
      "/workspace/src/index.ts",
      "/workspace/system.log",
    ]);
  });
});
