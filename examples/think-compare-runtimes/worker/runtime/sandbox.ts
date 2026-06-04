import type { RuntimeFileStore } from "./file-tools";
import type { FixtureRuntime } from "./seed";

interface SandboxFixtureTarget {
  mkdir(path: string, options?: { recursive?: boolean }): Promise<unknown>;
  writeFile(path: string, contents: string): Promise<unknown>;
}

interface SandboxReadFileResult {
  content: string | Uint8Array;
}

interface SandboxFileStoreTarget {
  readFile(path: string): Promise<SandboxReadFileResult>;
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

export function createSandboxFileStore(sandbox: SandboxFileStoreTarget): RuntimeFileStore {
  return {
    async readFile(path) {
      const file = await sandbox.readFile(path);
      return typeof file.content === "string"
        ? file.content
        : new TextDecoder().decode(file.content);
    },
    async writeFile(path, contents) {
      await sandbox.writeFile(path, contents);
    },
  };
}
