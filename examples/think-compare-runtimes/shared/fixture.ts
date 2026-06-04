export interface FixtureFile {
  path: string;
  contents: string;
}

export interface ComparisonFixture {
  root: string;
  task: string;
  files: FixtureFile[];
}

export const comparisonFixture: ComparisonFixture = {
  root: "/workspace/repo",
  task: "Make the tests pass, keep the public API small, and explain the change.",
  files: [
    {
      path: "package.json",
      contents: `${JSON.stringify(
        {
          scripts: {
            test: "vitest run",
          },
          dependencies: {},
          devDependencies: {
            typescript: "^6.0.3",
            vitest: "^4.1.7",
          },
        },
        null,
        2,
      )}\n`,
    },
    {
      path: "src/index.ts",
      contents: `export function summarizeScores(scores: number[]): string {\n  const total = scores.reduce((sum, score) => sum + score, 0);\n  return String(total / scores.length);\n}\n`,
    },
    {
      path: "src/index.test.ts",
      contents: `import { describe, expect, test } from "vitest";\nimport { summarizeScores } from "./index";\n\ndescribe("summarizeScores", () => {\n  test("formats the average score", () => {\n    expect(summarizeScores([8, 9, 10])).toBe("9.0");\n  });\n\n  test("handles an empty score list", () => {\n    expect(summarizeScores([])).toBe("No scores yet");\n  });\n});\n`,
    },
  ],
};
