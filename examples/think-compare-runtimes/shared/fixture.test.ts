import { describe, expect, test } from "vitest";
import { comparisonFixture } from "./fixture";

describe("comparisonFixture", () => {
  test("defines a docs feature task for both runtimes", () => {
    expect(comparisonFixture.root).toBe("/workspace/repo");
    expect(comparisonFixture.files.map((file) => file.path)).toEqual([
      "package.json",
      "README.md",
      "style-guide.md",
      "docs-nav.json",
      "feature-briefs/smart-request-policies.md",
      "docs/workers/index.md",
      "docs/workers/routing.md",
      "docs/workers/security.md",
      "docs/workers/examples/authenticated-api.md",
      "docs/workers/examples/rate-limit.md",
      "docs/_partials/beta-note.md",
      "scripts/check-docs.mjs",
    ]);
    expect(comparisonFixture.task).toContain("Add documentation for Smart Request Policies");
    expect(comparisonFixture.task).toContain("create a new Workers docs page");
    expect(comparisonFixture.task).toContain("update the docs navigation");
  });

  test("provides source material for a file-first docs workflow", () => {
    const brief = fileContents("feature-briefs/smart-request-policies.md");
    const styleGuide = fileContents("style-guide.md");
    const nav = fileContents("docs-nav.json");
    const checker = fileContents("scripts/check-docs.mjs");

    expect(brief).toContain("Smart Request Policies");
    expect(brief).toContain("Enterprise report exports");
    expect(styleGuide).toContain("Frontmatter");
    expect(styleGuide).toContain("Workers docs style");
    expect(nav).toContain("Workers");
    expect(checker).toContain("docs/workers/smart-request-policies.md");
    expect(checker).toContain("docs-nav.json");
  });
});

function fileContents(path: string): string {
  const file = comparisonFixture.files.find((candidate) => candidate.path === path);
  expect(file, `missing fixture file ${path}`).toBeTruthy();
  return file?.contents ?? "";
}
