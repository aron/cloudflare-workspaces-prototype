import type { RuntimeFileStore } from "./file-tools";
import type { FixtureRuntime } from "./seed";

interface WorkspaceFixtureTarget {
  fs: {
    mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
    writeFile(path: string, contents: string): Promise<void>;
  };
}

interface WorkspaceFileStoreTarget {
  fs: {
    readFile(path: string, encoding: "utf8"): Promise<string>;
    writeFile(path: string, contents: string): Promise<void>;
  };
}

export function createWorkspaceFixtureRuntime(workspace: WorkspaceFixtureTarget): FixtureRuntime {
  return {
    mkdir(path) {
      return workspace.fs.mkdir(path, { recursive: true });
    },
    writeFile(path, contents) {
      return workspace.fs.writeFile(path, contents);
    },
  };
}

export function createWorkspaceFileStore(workspace: WorkspaceFileStoreTarget): RuntimeFileStore {
  return {
    readFile(path) {
      return workspace.fs.readFile(path, "utf8");
    },
    writeFile(path, contents) {
      return workspace.fs.writeFile(path, contents);
    },
  };
}
