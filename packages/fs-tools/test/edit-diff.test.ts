import { describe, expect, it } from "vitest";
import {
  applyEditsToNormalizedContent,
  detectLineEnding,
  generateDiffString,
  generateUnifiedPatch,
  normalizeForFuzzyMatch,
  normalizeToLF,
  restoreLineEndings,
  stripBom,
} from "../src/edit-diff.js";

describe("line-ending helpers", () => {
  it("detectLineEnding returns CRLF when the first line ends with CRLF", () => {
    expect(detectLineEnding("a\r\nb\nc")).toBe("\r\n");
  });
  it("detectLineEnding returns LF when the first line ends with LF", () => {
    expect(detectLineEnding("a\nb\r\nc")).toBe("\n");
  });
  it("detectLineEnding returns LF for content with no line endings", () => {
    expect(detectLineEnding("single line")).toBe("\n");
  });

  it("normalizeToLF collapses CRLF and lone CR to LF", () => {
    expect(normalizeToLF("a\r\nb\rc\n")).toBe("a\nb\nc\n");
  });

  it("restoreLineEndings round-trips CRLF", () => {
    expect(restoreLineEndings("a\nb\n", "\r\n")).toBe("a\r\nb\r\n");
  });
  it("restoreLineEndings is identity for LF", () => {
    expect(restoreLineEndings("a\nb\n", "\n")).toBe("a\nb\n");
  });
});

describe("stripBom", () => {
  it("strips a leading BOM and reports it", () => {
    const { bom, text } = stripBom("\uFEFFhello");
    expect(bom).toBe("\uFEFF");
    expect(text).toBe("hello");
  });
  it("leaves non-BOM content alone", () => {
    expect(stripBom("hello")).toEqual({ bom: "", text: "hello" });
  });
});

describe("normalizeForFuzzyMatch", () => {
  it("strips trailing whitespace per line", () => {
    expect(normalizeForFuzzyMatch("a   \nb\t\nc")).toBe("a\nb\nc");
  });
  it("folds smart quotes, dashes, and special spaces", () => {
    // U+2018 / U+2019 → '
    // U+201C / U+201D → "
    // U+2014 (em dash) → -
    // U+00A0 (NBSP) → space
    expect(normalizeForFuzzyMatch("\u2018a\u2019 \u201Cb\u201D\u2014c\u00A0d")).toBe("'a' \"b\"-c d");
  });
});

describe("applyEditsToNormalizedContent", () => {
  it("replaces a single unique block", () => {
    const r = applyEditsToNormalizedContent("hello world", [{ oldText: "world", newText: "there" }], "/f");
    expect(r.newContent).toBe("hello there");
  });

  it("applies multiple disjoint edits against the original content", () => {
    const r = applyEditsToNormalizedContent(
      "alpha beta gamma",
      [
        { oldText: "alpha", newText: "A" },
        { oldText: "gamma", newText: "G" },
      ],
      "/f",
    );
    expect(r.newContent).toBe("A beta G");
  });

  it("rejects an empty oldText", () => {
    expect(() =>
      applyEditsToNormalizedContent("x", [{ oldText: "", newText: "y" }], "/f"),
    ).toThrow(/must not be empty/);
  });

  it("rejects non-unique oldText", () => {
    expect(() =>
      applyEditsToNormalizedContent("foo foo", [{ oldText: "foo", newText: "bar" }], "/f"),
    ).toThrow(/2 occurrences/);
  });

  it("rejects missing oldText", () => {
    expect(() =>
      applyEditsToNormalizedContent("hello", [{ oldText: "zzz", newText: "x" }], "/f"),
    ).toThrow(/Could not find/);
  });

  it("rejects overlapping edits", () => {
    expect(() =>
      applyEditsToNormalizedContent(
        "abcdef",
        [
          { oldText: "abcd", newText: "X" },
          { oldText: "cdef", newText: "Y" },
        ],
        "/f",
      ),
    ).toThrow(/overlap/);
  });

  it("rejects a no-op replacement", () => {
    expect(() =>
      applyEditsToNormalizedContent("hello", [{ oldText: "hello", newText: "hello" }], "/f"),
    ).toThrow(/No changes/);
  });

  it("performs fuzzy matching across smart-quote differences", () => {
    // Input has smart quotes, edit uses ASCII quotes
    const r = applyEditsToNormalizedContent(
      "say \u201Chi\u201D to me",
      [{ oldText: 'say "hi"', newText: 'say "bye"' }],
      "/f",
    );
    expect(r.newContent).toContain('say "bye"');
  });
});

describe("generateUnifiedPatch", () => {
  it("produces a standard unified diff with file headers", () => {
    const patch = generateUnifiedPatch("/a.txt", "alpha\nbeta\n", "alpha\ngamma\n");
    expect(patch).toMatch(/--- /);
    expect(patch).toMatch(/\+\+\+ /);
    expect(patch).toContain("-beta");
    expect(patch).toContain("+gamma");
  });
});

describe("generateDiffString", () => {
  it("reports the first changed line in the new file", () => {
    const r = generateDiffString("a\nb\nc\nd\n", "a\nb\nC\nd\n");
    expect(r.firstChangedLine).toBe(3);
  });
  it("emits +/- markers with line numbers", () => {
    const r = generateDiffString("a\nb\n", "a\nB\n");
    expect(r.diff).toContain("-2 b");
    expect(r.diff).toContain("+2 B");
  });
});
