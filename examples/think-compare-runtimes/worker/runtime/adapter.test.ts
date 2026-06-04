import { describe, expect, test } from "vitest";
import { RunEventRecorder } from "../run-events";
import { createSandboxRuntimeAdapter, createWorkspaceRuntimeAdapter } from "./adapter";

describe("runtime adapters", () => {
  test("createWorkspaceRuntimeAdapter exposes runtime-neutral file tools", async () => {
    const files = new Map<string, string>([["/workspace/repo/src/index.ts", "workspace file"]]);
    const recorder = new RunEventRecorder({ runId: "run-abc" });
    const adapter = createWorkspaceRuntimeAdapter({
      recorder,
      workspace: {
        fs: {
          async readFile(path: string, encoding: "utf8") {
            expect(encoding).toBe("utf8");
            return files.get(path) ?? "";
          },
          async writeFile(path: string, contents: string) {
            files.set(path, contents);
          },
        },
      },
    });

    expect(adapter.runtime).toBe("workspace");
    await expect(adapter.files.read("/workspace/repo/src/index.ts")).resolves.toBe(
      "workspace file",
    );
    await adapter.files.write("/workspace/repo/src/created.ts", "created");
    expect(files.get("/workspace/repo/src/created.ts")).toBe("created");
    expect(recorder.events().map((event) => event.runtime)).toEqual([
      "workspace",
      "workspace",
      "workspace",
      "workspace",
    ]);
  });

  test("createSandboxRuntimeAdapter exposes runtime-neutral file tools", async () => {
    const files = new Map<string, string>([["/workspace/repo/src/index.ts", "sandbox file"]]);
    const recorder = new RunEventRecorder({ runId: "run-abc" });
    const adapter = createSandboxRuntimeAdapter({
      recorder,
      sandbox: {
        async readFile(path: string) {
          return { content: files.get(path) ?? "" };
        },
        async writeFile(path: string, contents: string) {
          files.set(path, contents);
        },
      },
    });

    expect(adapter.runtime).toBe("sandbox");
    await expect(adapter.files.read("/workspace/repo/src/index.ts")).resolves.toBe("sandbox file");
    await adapter.files.write("/workspace/repo/src/created.ts", "created");
    expect(files.get("/workspace/repo/src/created.ts")).toBe("created");
    expect(recorder.events().map((event) => event.runtime)).toEqual([
      "sandbox",
      "sandbox",
      "sandbox",
      "sandbox",
    ]);
  });
});
