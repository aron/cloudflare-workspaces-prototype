import type { FixtureRuntime } from "./seed";

interface SandboxFixtureTarget {
  mkdir(path: string, options?: { recursive?: boolean }): Promise<unknown>;
  writeFile(path: string, contents: string): Promise<unknown>;
}

export function createSandboxFixtureRuntime(sandbox: SandboxFixtureTarget): FixtureRuntime {
  return {
    async mkdir(path) {
      await sandbox.mkdir(path, { recursive: true });
    },
    async writeFile(path, contents) {
      await sandbox.writeFile(path, contents);
    },
  };
}
