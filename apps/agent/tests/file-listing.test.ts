/**
 * Pure-function tests for buildListing — turns a VFS snapshot into a
 * sorted, scored autocomplete listing.
 *
 * Two modes:
 *   - Path-prefix mode (query starts with `/`): walks the tree, keeps
 *     directories visible so the user can Tab-drill-in.
 *   - Fuzzy mode (anything else): subsequence match across basenames,
 *     fallback to full path, fzf-style bonuses for boundaries +
 *     consecutive chars.
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

describe("buildListing — path prefix mode", () => {
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

  it("treats slash-containing query without leading / as the same path prefix", () => {
    // Client strips the !/ trigger before sending; `workspace/sk` is what
    // the server sees and should match `/workspace/sk*`.
    const out = buildListing(ENTRIES, "workspace/sk", 20);
    expect(out.entries.map((e) => e.path)).toEqual([
      "/workspace/skills",
      "/workspace/skills/foo.md",
    ]);
  });

  it("bare / returns top-level entries (dirs first)", () => {
    const out = buildListing(ENTRIES, "/", 100);
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

describe("buildListing — fuzzy mode", () => {
  it("ranks an exact basename match first", () => {
    const out = buildListing(ENTRIES, "foo.md", 10);
    expect(out.entries[0].path).toBe("/workspace/skills/foo.md");
  });

  it("matches by subsequence of the basename, case-insensitive", () => {
    const out = buildListing(ENTRIES, "agt", 10);
    expect(out.entries.map((e) => e.path)).toContain("/workspace/src/agent.ts");
  });

  it("returns files outweighing dirs when scores are similar", () => {
    // 'src' is both a dir name and a substring of 'src/agent.ts' / 'src/index.ts'.
    // The dir itself has a perfect basename match, so it surfaces first.
    const out = buildListing(ENTRIES, "src", 10);
    expect(out.entries[0].path).toBe("/workspace/src");
  });

  it("prefers basename matches over path matches", () => {
    const entries: ListingEntry[] = [
      { path: "/a/foo/something", type: "file" },
      { path: "/b/foo.png", type: "file" },
    ];
    const out = buildListing(entries, "foo", 10);
    // The basename match (/b/foo.png) outranks the path match
    // (/a/foo/something).
    expect(out.entries[0].path).toBe("/b/foo.png");
  });

  it("rewards matches at word boundaries", () => {
    const entries: ListingEntry[] = [
      { path: "/x/notes-README.md", type: "file" },
      { path: "/x/README.md",       type: "file" },
    ];
    const out = buildListing(entries, "rd", 10);
    // README starts at a clean boundary in both; the second has the
    // boundary at the very start of basename which wins.
    expect(out.entries[0].path).toBe("/x/README.md");
  });

  it("returns an empty list when nothing matches", () => {
    expect(buildListing(ENTRIES, "xyz123", 10).entries).toEqual([]);
  });
});

describe("buildListing — default ignores", () => {
  const messy: ListingEntry[] = [
    { path: "/workspace/node_modules", type: "dir" },
    { path: "/workspace/node_modules/foo/index.js", type: "file" },
    { path: "/workspace/.git", type: "dir" },
    { path: "/workspace/.git/HEAD", type: "file" },
    { path: "/workspace/src/foo.ts", type: "file" },
    { path: "/workspace/foo.ts", type: "file" },
  ];

  it("excludes node_modules entries from fuzzy results", () => {
    const out = buildListing(messy, "foo", 20);
    expect(out.entries.map(e => e.path)).not.toContain(
      "/workspace/node_modules/foo/index.js",
    );
  });

  it("excludes .git entries from fuzzy results", () => {
    const out = buildListing(messy, "HEAD", 20);
    expect(out.entries.map(e => e.path)).toEqual([]);
  });

  it("excludes ignored entries from path-prefix results too", () => {
    const out = buildListing(messy, "/workspace/", 20);
    const paths = out.entries.map(e => e.path);
    expect(paths).not.toContain("/workspace/node_modules");
    expect(paths).not.toContain("/workspace/node_modules/foo/index.js");
    expect(paths).not.toContain("/workspace/.git");
    expect(paths).not.toContain("/workspace/.git/HEAD");
  });

  it("explicit ignore override controls what's filtered", () => {
    const out = buildListing(messy, "foo", 20, { ignore: [] });
    expect(out.entries.map(e => e.path)).toContain(
      "/workspace/node_modules/foo/index.js",
    );
  });
});
