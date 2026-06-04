import { describe, expect, test } from "vitest";
import { comparisonFixture } from "../../shared/fixture";
import { runWorkspaceFixtureSetup } from "./workspace-run";

describe("runWorkspaceFixtureSetup", () => {
  test("seeds the fixture and returns Workspace timeline events", async () => {
    const writes: string[] = [];

    const events = await runWorkspaceFixtureSetup({
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
        id: "run-abc:workspace:0",
        runId: "run-abc",
        sequence: 1,
        runtime: "workspace",
        kind: "runtime_note",
        title: "Workspace fixture seeded",
        detail:
          "Wrote 3 files through Workspace.fs at /workspace/repo before starting a shell container.",
        timestamp: "2026-06-04T00:00:00.000Z",
      },
    ]);
  });
});
