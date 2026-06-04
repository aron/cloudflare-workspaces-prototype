import { describe, expect, test } from "vitest";
import { comparisonFixture } from "../../shared/fixture";
import { seedFixture } from "./seed";
import {
  createWorkspaceCommandRunner,
  createWorkspaceFileStore,
  createWorkspaceFixtureRuntime,
} from "./workspace";

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

  test("adapts Workspace.fs to the text file store interface", async () => {
    const calls: string[] = [];
    const workspace = {
      fs: {
        async readFile(path: string, encoding: "utf8") {
          calls.push(`read ${path} ${encoding}`);
          return "contents";
        },
        async writeFile(path: string, contents: string) {
          calls.push(`write ${path} ${contents}`);
        },
      },
    };
    const store = createWorkspaceFileStore(workspace);

    await expect(store.readFile("/workspace/repo/src/index.ts")).resolves.toBe("contents");
    await store.writeFile("/workspace/repo/src/index.ts", "updated");

    expect(calls).toEqual([
      "read /workspace/repo/src/index.ts utf8",
      "write /workspace/repo/src/index.ts updated",
    ]);
  });

  test("exec connects the Workspace shell lazily", async () => {
    const calls: string[] = [];
    const runner = createWorkspaceCommandRunner({
      async ready() {
        calls.push("ready");
      },
      shell: {
        async exec(
          command: string,
          options?: { cwd?: string; encoding?: "utf8"; timeoutMs?: number },
        ) {
          calls.push(`${command} ${options?.cwd} ${options?.encoding} ${options?.timeoutMs}`);
          return {
            async result() {
              calls.push("result");
              return { exitCode: 0, stdout: "workspace\n", stderr: "", pushed: 1, pulled: 1 };
            },
          };
        },
      },
    });

    await expect(
      runner.exec("npm test", { cwd: "/workspace/repo", timeoutMs: 30_000 }),
    ).resolves.toEqual({ exitCode: 0, stdout: "workspace\n", stderr: "" });
    expect(calls).toEqual(["ready", "npm test /workspace/repo utf8 30000", "result"]);
  });
});
