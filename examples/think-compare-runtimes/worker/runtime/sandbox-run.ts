import type { RunEvent } from "../../shared/events";
import type { ComparisonFixture } from "../../shared/fixture";
import { type FixtureRuntime, seedFixture } from "./seed";

export interface SandboxFixtureSetupOptions {
  runId: string;
  fixture: ComparisonFixture;
  runtime: FixtureRuntime;
  now?: () => string;
}

export async function runSandboxFixtureSetup({
  runId,
  fixture,
  runtime,
  now = () => new Date().toISOString(),
}: SandboxFixtureSetupOptions): Promise<RunEvent[]> {
  await seedFixture(runtime, fixture);

  return [
    {
      id: `${runId}:sandbox:0`,
      runId,
      sequence: 2,
      runtime: "sandbox",
      kind: "runtime_note",
      title: "Sandbox fixture seeded",
      detail: `Wrote ${fixture.files.length} files through Sandbox SDK file operations at ${fixture.root}.`,
      timestamp: now(),
    },
  ];
}
