import { describe, expect, test } from "vitest";
import { comparisonFixture } from "../../shared/fixture";
import { createSandboxFixtureRuntime } from "./sandbox";
import { seedFixture } from "./seed";

describe("createSandboxFixtureRuntime", () => {
  test("seeds through Sandbox file operations", async () => {
    const calls: Array<{ type: "mkdir" | "write"; path: string; contents?: string }> = [];
    const sandbox = {
      async mkdir(path: string, options?: { recursive?: boolean }) {
        if (options?.recursive !== true) {
          throw new Error("Sandbox fixture mkdir must be recursive");
        }
        calls.push({ type: "mkdir", path });
      },
      async writeFile(path: string, contents: string) {
        calls.push({ type: "write", path, contents });
      },
    };

    await seedFixture(createSandboxFixtureRuntime(sandbox), comparisonFixture);

    expect(calls).toEqual([
      { type: "mkdir", path: "/workspace/repo" },
      {
        type: "write",
        path: "/workspace/repo/package.json",
        contents: comparisonFixture.files[0]?.contents,
      },
      { type: "mkdir", path: "/workspace/repo/src" },
      {
        type: "write",
        path: "/workspace/repo/src/index.ts",
        contents: comparisonFixture.files[1]?.contents,
      },
      { type: "mkdir", path: "/workspace/repo/src" },
      {
        type: "write",
        path: "/workspace/repo/src/index.test.ts",
        contents: comparisonFixture.files[2]?.contents,
      },
    ]);
  });
});
