# 09. Tool Interface (Agents)

> [!IMPORTANT]
> This document describes the **intended design** and has **diverged
> from the current implementation** in the repository. Names,
> signatures, and behaviours described here are targets, not what
> `main` ships today. When in doubt, treat the code as authoritative
> for what runs and this doc as authoritative for what we're moving
> toward.

The `@cloudflare/fs-tools` package ships ready-made
[AI SDK](https://github.com/vercel/ai) tools that drive a `Workspace`
through its `FileStore` adapter. Drop them into a `@cloudflare/agents`
agent and the model can read, write, and edit files in the workspace
without you wiring tool definitions by hand.

## What ships

| Tool | Purpose |
| --- | --- |
| `createReadTool` | Memory-efficient, line-windowed file read. |
| `createWriteTool` | Whole-file write with a UTF-8 byte cap. |
| `createEditTool` | Fuzzy-matched targeted replacements with unified-diff preview. |
| `createGrepTool` | Recursive content search across the workspace. |
| `createExecTool` | Run a shell command inside the sandbox container. |

Plus the low-level building blocks:

- `WorkspaceFileStore` — adapts a `Workspace` to the `FileStore` shape
  the tools consume.
- `InMemoryFileStore` — in-memory implementation for tests.
- `FileStore`, `FileStat` types and the diff helpers (`generateDiffString`,
  `generateUnifiedPatch`, `applyEditsToNormalizedContent`, etc.).

## Wiring up

```ts
import { AIChatAgent } from "@cloudflare/ai-chat";
import { Workspace } from "@cloudflare/workspace";
import {
  WorkspaceFileStore,
  createReadTool,
  createWriteTool,
  createEditTool,
  createGrepTool,
  createExecTool,
} from "@cloudflare/fs-tools";

export class Agent extends AIChatAgent<Env> {
  workspace: Workspace;

  constructor(...args: ConstructorParameters<typeof AIChatAgent>) {
    super(...(args as [any, any]));
    this.workspace = new Workspace({ /* ... */ });
  }

  tools() {
    const store = new WorkspaceFileStore(this.workspace);
    return {
      read:  createReadTool({ store }),
      write: createWriteTool({ store }),
      edit:  createEditTool({ store }),
      grep:  createGrepTool({ workspace: this.workspace }),
      exec:  createExecTool({ workspace: this.workspace }),
    };
  }
}
```

The tools are plain AI SDK `Tool` objects — pass them straight to
`generateText` / `streamText` or expose them through the agent's tool
registry.

## `read`

```ts
createReadTool({ store, maxLines?, maxBytes? });
```

| Option | Default | Notes |
| --- | --- | --- |
| `maxLines` | 2000 | Hard line cap per call. |
| `maxBytes` | 256 KiB | Hard byte cap per call. |

Schema:

```ts
{
  path:   string;            // absolute path
  offset?: number;           // 1-indexed start line
  limit?:  number;           // max lines this call
}
```

Returns the line window plus a `nextOffset` whenever the result was
truncated, so the model can call `read` again to keep going. Lazy
through `store.readChunks(path)` — never materializes the full file
unless the file itself fits in the budget.

## `write`

```ts
createWriteTool({ store, maxBytes? });
```

| Option | Default |
| --- | --- |
| `maxBytes` | 2 MiB |

Schema:

```ts
{
  path:    string;
  content: string;
}
```

Overwrites the file. Preserves an existing file's `mode` so executable
scripts keep their `+x` bit. Rejects writes larger than `maxBytes` with
a structured error pointing the model at the `edit` tool.

## `edit`

```ts
createEditTool({ store, maxBytes? });
```

| Option | Default |
| --- | --- |
| `maxBytes` | 2 MiB |

Schema:

```ts
{
  path:  string;
  edits: Array<{ oldText: string; newText: string }>;
}
```

Each edit is matched against the *original* file content (not
incrementally), so overlapping or nested edits are rejected. The tool
handles:

- BOM stripping and line-ending normalization (LF for matching, restored
  on write).
- Fuzzy matching that tolerates whitespace drift.
- Unified-diff generation for the model to review.

## `grep`

```ts
createGrepTool({ workspace, maxHits?, maxBytesPerLine? });
```

| Option | Default | Notes |
| --- | --- | --- |
| `maxHits` | 200 | Hard cap on returned hits. Truncation is reported in the result. |
| `maxBytesPerLine` | 1 KiB | Lines longer than this are truncated to keep the model context manageable. |

Schema:

```ts
{
  pattern:     string;            // literal by default, or a regex if `regex: true`
  path:        string;            // absolute path; directory or file
  regex?:      boolean;           // treat pattern as a regex
  ignoreCase?: boolean;
  glob?:       string;            // restrict to paths matching this glob
}
```

Delegates to `Workspace.grep` (see
[04. Filesystem Interface](./04_filesystem_interface.md#grep)). Runs
container-side when a sandbox is available so big trees use ripgrep;
falls back to the DO-side scan otherwise. Returns
`{ hits: Array<{ path, line, text }>, truncated: boolean }` so the model
can tell when results were capped and refine the query.

## `exec`

```ts
createExecTool({ workspace, defaultCwd?, allowedCommands?, timeoutMs? });
```

| Option | Default | Notes |
| --- | --- | --- |
| `defaultCwd` | workspace root | Applied when the model doesn't pass `cwd`. |
| `allowedCommands` | `undefined` (anything) | Optional allow-list of command prefixes. Anything else is rejected before reaching the sandbox. |
| `timeoutMs` | 60_000 | Auto-`kill()` after this long. Set to `0` to disable. |

Schema:

```ts
{
  command: string;                // full command line, run through a shell
  cwd?:    string;                // absolute path inside the workspace
}
```

Calls `Workspace.shell.exec` with `encoding: "utf8"`, waits for
`result()`, and returns
`{ exitCode, stdout, stderr, truncated }`. stdout and stderr are each
capped at a fixed byte budget (default 32 KiB) so a chatty command
can't blow the model's context window; `truncated` flags when the cap
was hit. See [05. Shell Interface](./05_shell_interface.md) for the
underlying API and the open questions around long-running execs.

Wire this tool up carefully: it executes arbitrary shell commands
inside the sandbox. Pair it with `allowedCommands` (or a system-prompt
policy) unless the agent is fully trusted.

## `FileStore`

The shape the tools depend on:

```ts
interface FileStore {
  stat(path: string): Promise<FileStat | null>;
  read(path: string): Promise<Uint8Array | null>;
  readChunks(path: string): AsyncIterable<Uint8Array>;
  write(path: string, bytes: Uint8Array, options?: { mode?: number }): Promise<void>;
}

interface FileStat {
  size:  number;
  mode:  number;
  mtime: number;
  type:  "file" | "dir";
}
```

`WorkspaceFileStore` adapts these to `Workspace.fs.readFile` /
`writeFile` / `stat`. Custom stores let the same tools drive an SSH
bridge, a remote git working tree, or any other FS-shaped backend.

Note: `grep` and `exec` take the `Workspace` directly rather than a
`FileStore`. They need the shell and search surfaces, which aren't part
of the `FileStore` contract.

## Conventions for agents

- Tools take absolute paths. Pre-resolve user input against the
  configured workspace root before calling (see
  [01. Directory Structure](./01_directory_structure.md)).
- The `read` tool returns continuation offsets — feed them back to the
  model on truncation rather than asking for the whole file.
- Pair the `edit` tool with a system prompt that tells the model edits
  apply against the *original* file. Models that incrementally update
  their mental model of the file will produce overlapping edits and
  get the rejection error.
- The `grep` tool returns a `truncated` flag when its hit cap is
  reached — prompt the model to refine the query instead of asking for
  more pages.
- The `exec` tool is the most dangerous of the set. Use
  `allowedCommands` to limit blast radius, and treat its
  `stdout`/`stderr` as untrusted attacker-controlled input when
  feeding them back into the model.
