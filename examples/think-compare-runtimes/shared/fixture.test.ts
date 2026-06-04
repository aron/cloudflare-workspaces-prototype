import { describe, expect, test } from "vitest";
import { comparisonFixture } from "./fixture";

describe("comparisonFixture", () => {
  test("defines the same starting files and task for both runtimes", () => {
    expect(comparisonFixture.root).toBe("/workspace/repo");
    expect(comparisonFixture.files.map((file) => file.path)).toEqual([
      "package.json",
      "src/index.ts",
      "src/index.test.ts",
    ]);
    expect(comparisonFixture.task).toContain("Make the tests pass");
  });
});
