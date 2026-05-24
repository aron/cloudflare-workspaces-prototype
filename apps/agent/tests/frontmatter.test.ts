/**
 * Pure tests for src/frontmatter.ts.
 *
 * Skill files follow the Agent Skills spec: a YAML-ish front-matter block
 * delimited by `---` lines at the top of the file, then a Markdown body.
 * We only parse what the spec requires — flat key: value pairs with
 * string scalars and an optional boolean flag — so the parser stays
 * tiny and dependency-free.
 */
import { describe, it, expect } from "vitest";
import { parseFrontmatter } from "../src/frontmatter.js";

describe("parseFrontmatter", () => {
  it("returns empty frontmatter and the original body when no fence is present", () => {
    const r = parseFrontmatter("just some markdown\n");
    expect(r.frontmatter).toEqual({});
    expect(r.body).toBe("just some markdown\n");
  });

  it("parses scalar string keys between --- fences", () => {
    const src = "---\nname: cloudflare-workers\ndescription: Workers fundamentals.\n---\n\n# Body\n";
    const r = parseFrontmatter(src);
    expect(r.frontmatter.name).toBe("cloudflare-workers");
    expect(r.frontmatter.description).toBe("Workers fundamentals.");
    expect(r.body).toBe("# Body\n");
  });

  it("strips surrounding double quotes from values", () => {
    const r = parseFrontmatter('---\ndescription: "with: colons, and commas"\n---\nbody');
    expect(r.frontmatter.description).toBe("with: colons, and commas");
  });

  it("strips surrounding single quotes from values", () => {
    const r = parseFrontmatter("---\ndescription: 'apos value'\n---\nbody");
    expect(r.frontmatter.description).toBe("apos value");
  });

  it("recognises true/false on the disable-model-invocation flag", () => {
    const t = parseFrontmatter("---\ndisable-model-invocation: true\n---\n");
    const f = parseFrontmatter("---\ndisable-model-invocation: false\n---\n");
    expect(t.frontmatter["disable-model-invocation"]).toBe(true);
    expect(f.frontmatter["disable-model-invocation"]).toBe(false);
  });

  it("ignores blank lines inside the front-matter block", () => {
    const r = parseFrontmatter("---\n\nname: x\n\ndescription: y\n---\nbody");
    expect(r.frontmatter).toEqual({ name: "x", description: "y" });
  });

  it("ignores comment lines (leading #) inside front-matter", () => {
    const r = parseFrontmatter("---\n# a comment\nname: x\n---\nbody");
    expect(r.frontmatter).toEqual({ name: "x" });
    expect(r.body).toBe("body");
  });

  it("returns empty frontmatter when the front-matter block never closes", () => {
    // Malformed — treat the whole input as body, no front-matter parsed.
    const src = "---\nname: x\nno closing fence ever\n";
    const r = parseFrontmatter(src);
    expect(r.frontmatter).toEqual({});
    expect(r.body).toBe(src);
  });

  it("only consumes the first --- block at the very top of the file", () => {
    // A `---` line later in the body is not a fence.
    const src = "---\nname: x\n---\nfirst paragraph\n---\nsecond paragraph\n";
    const r = parseFrontmatter(src);
    expect(r.frontmatter).toEqual({ name: "x" });
    expect(r.body).toBe("first paragraph\n---\nsecond paragraph\n");
  });

  it("handles CRLF line endings", () => {
    const src = "---\r\nname: x\r\ndescription: y\r\n---\r\nbody\r\n";
    const r = parseFrontmatter(src);
    expect(r.frontmatter).toEqual({ name: "x", description: "y" });
  });

  it("preserves unknown keys as string values", () => {
    const r = parseFrontmatter("---\nname: x\ncustom-key: hello\n---\n");
    expect(r.frontmatter["custom-key"]).toBe("hello");
  });
});
