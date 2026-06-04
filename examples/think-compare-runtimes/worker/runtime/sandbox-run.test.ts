import { describe, expect, test } from "vitest";
import { comparisonFixture } from "../../shared/fixture";
import { runSandboxFixtureSetup } from "./sandbox-run";

describe("runSandboxFixtureSetup", () => {
  test("seeds the fixture and returns Sandbox timeline events", async () => {
    const writes: string[] = [];

    const events = await runSandboxFixtureSetup({
      runId: "run-abc",
      fixture: comparisonFixture,
      now: () => "2026-06-04T00:00:00.000Z",
      runtime: {
        async mkdir() {},
        async writeFile(path) {
          writes.push(path);
        },
      },
    });

    expect(writes).toEqual([
      "/workspace/repo/package.json",
      "/workspace/repo/src/index.ts",
      "/workspace/repo/src/index.test.ts",
    ]);
    expect(events).toEqual([
      {
        id: "run-abc:sandbox:0",
        runId: "run-abc",
        sequence: 2,
        runtime: "sandbox",
        kind: "runtime_note",
        title: "Sandbox fixture seeded",
        detail: "Wrote 3 files through Sandbox SDK file operations at /workspace/repo.",
        timestamp: "2026-06-04T00:00:00.000Z",
      },
    ]);
  });
});
