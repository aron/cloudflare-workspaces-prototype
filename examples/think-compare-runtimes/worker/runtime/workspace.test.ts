import { describe, expect, test } from "vitest";
import { comparisonFixture } from "../../shared/fixture";
import { seedFixture } from "./seed";
import { createWorkspaceFixtureRuntime } from "./workspace";

describe("createWorkspaceFixtureRuntime", () => {
  test("seeds through Workspace.fs without connecting a shell backend", async () => {
    const calls: Array<{ type: "mkdir" | "write"; path: string; contents?: string }> = [];
    const workspace = {
      fs: {
        async mkdir(path: string, options?: { recursive?: boolean }) {
          if (options?.recursive !== true) {
            throw new Error("Workspace fixture mkdir must be recursive");
          }
          calls.push({ type: "mkdir", path });
        },
        async writeFile(path: string, contents: string) {
          calls.push({ type: "write", path, contents });
        },
      },
      async ready() {
        throw new Error("ready() should not be needed for file seeding");
      },
    };

    await seedFixture(createWorkspaceFixtureRuntime(workspace), comparisonFixture);

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
