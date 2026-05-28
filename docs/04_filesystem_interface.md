# 04. Filesystem Interface

> [!IMPORTANT]
> This document describes the **intended design** and has **diverged
> from the current implementation** in the repository. Names,
> signatures, and behaviours described here are targets, not what
> `main` ships today. When in doubt, treat the code as authoritative
> for what runs and this doc as authoritative for what we're moving
> toward.

`Workspace.fs` is the file API. It's inspired by `node:fs/promises` for
familiarity — same method names, similar option shapes — but it's a much
smaller surface and it leans on `ReadableStream<Uint8Array>` wherever a
file could be large.

```ts
interface Workspace {
  fs:    WorkspaceFilesystem;
  shell: WorkspaceShell;        // see 05_shell_interface.md
}
```

Three things to keep in mind when porting Node code over:

- Every method is **async**, even ones Node ships as sync-only.
- Paths are **absolute** and POSIX-style (see
  [01. Directory Structure](./01_directory_structure.md)).
- The default `readFile` return is a **stream**, not a Buffer. Pass
  `"utf8"` (or `{ encoding: "utf8" }`) when you actually want a string in
  memory. Use streams whenever the file could be larger than a few
  hundred KB — they pipe directly into `Response`, `fetch`, R2 `put`,
  and any other `ReadableStream` consumer without buffering.

See the [appendix](#appendix-comparison-with-nodefspromises) for a
method-by-method mapping against `node:fs/promises`.
## API

### `readFile`

```ts
readFile(path: string): Promise<ReadableStream<Uint8Array>>
readFile(path: string, encoding: "utf8"): Promise<string>
readFile(path: string, options: { encoding?: "utf8" }): Promise<string>
```

Defaulting to a stream is deliberate — most reads in an agent context
are "send this file somewhere" and never need to be in memory.

```ts
// Stream a large file straight to the client.
const stream = await fs.readFile("/workspace/build/out.wasm");
return new Response(stream, { headers: { "content-type": "application/wasm" } });

// Read a small text file into a string.
const todo = await fs.readFile("/workspace/notes/todo.md", "utf8");

// The verbose form, for symmetry with node:fs/promises.
const config = await fs.readFile("/workspace/config.json", { encoding: "utf8" });
```

### `writeFile`

```ts
writeFile(
  path:    string,
  content: string | Uint8Array | ReadableStream<Uint8Array>,
  options?: { mode?: number }
): Promise<void>
```

Accepts a stream, so uploads can be piped through without buffering.

```ts
// Text.
await fs.writeFile("/workspace/notes/todo.md", "- [ ] ship it\n");

// Binary.
await fs.writeFile("/workspace/data/blob.bin", new Uint8Array([1, 2, 3]));

// Stream an HTTP upload straight to disk.
await fs.writeFile("/workspace/uploads/big.csv", request.body!);

// Stream from an R2 object into the workspace.
const obj = await env.BUCKET.get("imports/data.parquet");
if (obj) await fs.writeFile("/workspace/imports/data.parquet", obj.body);

// Mark a script executable.
await fs.writeFile("/workspace/bin/run.sh", "#!/bin/sh\necho hi\n", { mode: 0o755 });
```

### `rm`

```ts
rm(path: string, options?: { recursive?: true; force?: true }): Promise<void>
```

Replaces both `unlink` and `rmdir`. Pass `recursive: true` for non-empty
directories; `force: true` silences `ENOENT`.

```ts
// Single file.
await fs.rm("/workspace/notes/todo.md");

// Recursive directory wipe.
await fs.rm("/workspace/build", { recursive: true });

// Idempotent cleanup.
await fs.rm("/workspace/cache", { recursive: true, force: true });
```

### `mkdir`

```ts
mkdir(path: string, options?: { recursive?: true; mode?: number }): Promise<void>
```

```ts
await fs.mkdir("/workspace/notes");
await fs.mkdir("/workspace/projects/a/b/c", { recursive: true });
```

### `readdir`

```ts
readdir(path: string): Promise<Array<{
  name:        string;
  parentPath:  string;
  isFile:      boolean;
  isDirectory: boolean;
}>>
```

Returns dirent-shaped entries by default so you don't need a follow-up
`stat()` to tell files from directories.

```ts
for (const entry of await fs.readdir("/workspace/notes")) {
  if (entry.isDirectory) console.log(`d ${entry.name}/`);
  else                   console.log(`f ${entry.name}`);
}
```

### `stat`

```ts
stat(path: string): Promise<{
  name:        string;
  mode:        number;
  mtime:       number;   // ms since epoch
  size:        number;
  isFile:      boolean;
  isDirectory: boolean;
}>
```

```ts
const s = await fs.stat("/workspace/build/out.wasm");
console.log(`${s.size} bytes, modified ${new Date(s.mtime).toISOString()}`);
```

### `findFiles`

```ts
findFiles(
  directory: string,
  pattern?:  string,           // simple glob (`*.ts`, `**/*.md`)
): Promise<Array<{ path: string; type: "file" | "dir" }>>
```

```ts
// Every TypeScript file in the project.
const ts = await fs.findFiles("/workspace/src", "**/*.ts");

// Everything under a directory (no pattern).
const all = await fs.findFiles("/workspace/notes");
```

### `listFilesUnder`

```ts
listFilesUnder(prefix: string): Promise<string[]>
```

Flat list of every file path that starts with `prefix`. Cheaper than
`findFiles` when you don't need the directory rows.

```ts
const paths = await fs.listFilesUnder("/workspace/.agents/skills");
```

### `grep`

Available on `Workspace.fs` for parity with the agent tools, and on
`Workspace.shell` when you want it to run inside the container (faster
for large trees because it uses ripgrep).

```ts
grep(
  pattern: string,
  path:    string,
  options?: { ignoreCase?: boolean }
): Promise<{ path: string; line: number; text: string }[]>
```

```ts
const hits = await fs.grep("TODO", "/workspace/src", { ignoreCase: true });
for (const hit of hits) {
  console.log(`${hit.path}:${hit.line}: ${hit.text}`);
}
```

See [05. Shell Interface](./05_shell_interface.md) for the container-side
variant.

## Error handling

Errors thrown by `fs` are POSIX-style — a `NodeJS.ErrnoException`-shaped
object with a `code` property — so handlers from Node code port over
directly.

| Code | When |
| --- | --- |
| `ENOENT` | Path does not exist and `force` is not true. |
| `ENOTEMPTY` | Path is a non-empty directory and `recursive` is not true. |
| `ENOTDIR` | A parent path segment is a file. |
| `EISDIR` | Expected a file, got a directory (e.g. `readFile` on a dir). |
| `EEXIST` | `mkdir` without `recursive: true` on an existing path. |
| `EINVAL` | Invalid path or unsupported options. |
| `EACCES` | Permission denied. |
| `EPERM` | Operation is forbidden, e.g. deleting the workspace root. |
| `EROFS` | Path is under a read-only mount. See [06. Mount Interface](./06_mount_interface.md). |
| `EIO` | Backing storage failed unexpectedly. |

### Example: handle "file missing" and bubble everything else

```ts
async function readConfig(): Promise<Config> {
  try {
    const text = await this.workspace.fs.readFile("/workspace/config.json", "utf8");
    return JSON.parse(text) as Config;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // First boot: seed a default config and return it.
      const seed: Config = { version: 1, theme: "dark" };
      await this.workspace.fs.writeFile(
        "/workspace/config.json",
        JSON.stringify(seed, null, 2),
      );
      return seed;
    }
    // Anything else (EIO, EROFS on a misconfigured mount, ...) is a real
    // problem — let it surface so the agent's outer error handler logs
    // it and the request fails loudly.
    throw err;
  }
}
```

### Example: idempotent cleanup

```ts
// Equivalent to `rm -rf` — never throws on missing paths.
await this.workspace.fs.rm("/workspace/build", { recursive: true, force: true });
```

### Example: write-through to a read-only mount

```ts
try {
  await this.workspace.fs.writeFile("/workspace/.agents/skills/new.md", body);
} catch (err) {
  if ((err as NodeJS.ErrnoException).code === "EROFS") {
    return new Response("Skills are read-only on this deployment.", { status: 403 });
  }
  throw err;
}
```

## Appendix: comparison with `node:fs/promises`

For reference, here's the public surface of `node:fs/promises` and how it
maps to `Workspace.fs`:

| `node:fs/promises` | `Workspace.fs` | Notes |
| --- | --- | --- |
| `readFile` | `readFile` | Stream by default; pass `"utf8"` for a string. |
| `writeFile` | `writeFile` | Accepts `string`, `Uint8Array`, or `ReadableStream`. |
| `appendFile` | — | Read, concat, write. Not a primitive. |
| `mkdir` | `mkdir` | `{ recursive: true }` supported. |
| `rmdir` | `rm` | One method for files and dirs (matches modern Node). |
| `rm` | `rm` | `{ recursive: true }` for non-empty dirs. |
| `unlink` | `rm` | Same. |
| `readdir` | `readdir` | Always returns dirent-shaped entries. |
| `stat` / `lstat` | `stat` | No symlink distinction — VFS has no symlinks. |
| `truncate` | — | Read, slice, write. |
| `chmod` | — | Pass `mode` to `writeFile` / `mkdir`. |
| `chown` | — | No ownership model. |
| `utimes` | — | `mtime` is managed by the VFS. |
| `cp` / `copyFile` | — | Read + write. |
| `rename` | — | Read + write + delete. |
| `realpath` | — | Paths are already canonical. |
| `symlink` / `readlink` | — | No symlink support. |
| `watch` | — | See [02. Sync Protocol](./02_sync_protocol.md) for the change stream. |
| `open` / `FileHandle` | — | Use streams instead. |
| `glob` | `findFiles` | Limited glob support. |
| — | `grep` | Not in `node:fs`; included here for agents. |
| — | `findFiles` | Recursive directory walk with an optional pattern. |
| — | `listFilesUnder` | Flat list of file paths under a prefix. |
