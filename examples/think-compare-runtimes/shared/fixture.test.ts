import { describe, expect, test } from "vitest";
import { comparisonFixture } from "./fixture";

describe("comparisonFixture", () => {
  test("defines the same starting files and task for both runtimes", () => {
    expect(comparisonFixture.root).toBe("/workspace/repo");
    expect(comparisonFixture.files.map((file) => file.path)).toEqual([
      "package.json",
      "README.md",
      "src/request-policy.ts",
      "src/request-policy.test.ts",
    ]);
    expect(comparisonFixture.task).toContain("Fix the request policy helper");
    expect(comparisonFixture.task).toContain("allow safe GET and HEAD requests");
    expect(comparisonFixture.task).toContain(
      "block mutating methods unless an explicit bypass token is present",
    );
  });

  test("provides a realistic request policy maintenance task", () => {
    const source = comparisonFixture.files.find((file) => file.path === "src/request-policy.ts");
    const tests = comparisonFixture.files.find(
      (file) => file.path === "src/request-policy.test.ts",
    );

    expect(source?.contents).toContain("export interface RequestPolicyDecision");
    expect(source?.contents).toContain("export function evaluateRequestPolicy");
    expect(tests?.contents).toContain("allows safe methods");
    expect(tests?.contents).toContain("allows mutating requests with the bypass token");
    expect(tests?.contents).toContain("reason");
  });
});
