/**
 * Pure helpers for the !/ path autocomplete popover:
 *
 *   buildListingUrl(threadId, text)  -> string | null
 *   acceptCompletion(text, entry)    -> { text, keepOpen }
 *   filterAndRank(entries, prefix)   -> Entry[]
 *
 * The hook + component layer is glue; these are the bits worth testing.
 */
import { describe, it, expect } from "vitest";
import {
  buildListingUrl,
  acceptCompletion,
  filterAndRank,
  type ListingEntry,
} from "../src/lib/path-autocomplete.js";

const tid = "thread123";

describe("buildListingUrl", () => {
  it("returns a listing URL when the input is in bang mode", () => {
    // After the !/ trigger, plain text is a fuzzy query.
    expect(buildListingUrl(tid, "!/foo")).toBe(
      `/api/threads/${tid}/files-list?prefix=foo&limit=20`,
    );
    // Slashes inside the query stay as-is so the server can do prefix mode.
    expect(buildListingUrl(tid, "!/workspace/sr")).toBe(
      `/api/threads/${tid}/files-list?prefix=workspace%2Fsr&limit=20`,
    );
  });

  it("returns null when the input isn't in bang mode", () => {
    expect(buildListingUrl(tid, "hello")).toBeNull();
    expect(buildListingUrl(tid, "!hello")).toBeNull();
    expect(buildListingUrl(tid, "")).toBeNull();
  });

  it("handles bare !/ as an empty query", () => {
    expect(buildListingUrl(tid, "!/")).toBe(
      `/api/threads/${tid}/files-list?prefix=&limit=20`,
    );
  });

  it("tolerates leading whitespace", () => {
    expect(buildListingUrl(tid, "  !/foo")).toBe(
      `/api/threads/${tid}/files-list?prefix=foo&limit=20`,
    );
  });
});

describe("acceptCompletion", () => {
  it("accepting a file replaces the input and signals close", () => {
    expect(acceptCompletion("!/wo", { path: "/workspace/foo.png", type: "file" })).toEqual({
      text: "!/workspace/foo.png",
      keepOpen: false,
    });
  });

  it("accepting a dir keeps the popover open with trailing slash", () => {
    expect(acceptCompletion("!/wo", { path: "/workspace/src", type: "dir" })).toEqual({
      text: "!/workspace/src/",
      keepOpen: true,
    });
  });

  it("does not double up trailing slash if the entry path already ends in /", () => {
    expect(acceptCompletion("!/", { path: "/workspace/", type: "dir" })).toEqual({
      text: "!/workspace/",
      keepOpen: true,
    });
  });
});

describe("filterAndRank", () => {
  const entries: ListingEntry[] = [
    { path: "/workspace/skills", type: "dir" },
    { path: "/workspace/src", type: "dir" },
    { path: "/workspace/README.md", type: "file" },
    { path: "/workspace/system.log", type: "file" },
  ];

  it("filters by prefix and sorts dirs first", () => {
    // Query as the popover sends it: trigger stripped, no leading slash.
    expect(filterAndRank(entries, "workspace/s").map((e) => e.path)).toEqual([
      "/workspace/skills",
      "/workspace/src",
      "/workspace/system.log",
    ]);
  });

  it("returns everything when prefix matches all", () => {
    expect(filterAndRank(entries, "workspace/").map((e) => e.path)).toEqual([
      "/workspace/skills",
      "/workspace/src",
      "/workspace/README.md",
      "/workspace/system.log",
    ]);
  });

  it("returns empty when nothing matches", () => {
    expect(filterAndRank(entries, "nope/")).toEqual([]);
  });

  it("passes fuzzy-query results through unchanged (trusts the server)", () => {
    // Server returned these in fuzzy-score order; we shouldn't reorder.
    const fuzzyResults: ListingEntry[] = [
      { path: "/workspace/foo.png", type: "file" },
      { path: "/workspace/src/foo.ts", type: "file" },
    ];
    expect(filterAndRank(fuzzyResults, "foo").map(e => e.path)).toEqual([
      "/workspace/foo.png",
      "/workspace/src/foo.ts",
    ]);
  });
});
