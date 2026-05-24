# @cloudflare/workspace

A Durable-Object-backed virtual filesystem that syncs incrementally with a
`@cloudflare/sandbox` container, plus a helper for running compiled WASM in
isolated Cloudflare Dynamic Workers.

<img width="2625" height="2284" alt="image" src="https://github.com/user-attachments/assets/ecb9ae36-567a-407d-93c6-9446b62cf8f3" />

Three entry points:

| Entry | Purpose |
|---|---|
| `@cloudflare/workspace`                  | DO-side: the `Workspace` class. |
| `@cloudflare/workspace/worker-sandbox`   | `runWasm()` — execute a WASM binary in a Dynamic Worker. |
| `@cloudflare/workspace/container-sandbox`| Pre-built container server (`COPY` it into your Dockerfile). |
| `@cloudflare/workspace/shared`           | Wire types and the capnweb RPC interface. |

## DO-side

```ts
import { Workspace, R2Bucket } from "@cloudflare/workspace";

export class MyAgent extends DurableObject {
  workspace: Workspace;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.workspace = new Workspace({
      storage:   ctx.storage,
      sandbox:   env.Sandbox,
      sessionId: ctx.id.name ?? ctx.id.toString(),
      mounts: {
        // Read-only mount. Index is built once on first use;
        // file content is fetched per-file on first read.
        "/workspace/.agents/skills": R2Bucket(env.SHARED_FILES, {
          prefix: ".agents/skills",
        }),
      },
    });
  }

  async someMethod() {
    await this.workspace.writeFile("/workspace/main.zig", "...");
    const result = await this.workspace.exec(
      "zig build-exe /workspace/main.zig -target wasm32-wasi",
    );
    return result.stdout;
  }
}
```

### Async API

Every read/write method on `Workspace` is `async` so the implementation can
lazily index a mount (one `R2.list()`) or fetch file bytes (one `R2.get()`)
without forcing callers to plumb a separate hydration step:

```ts
await workspace.readFile(path);
await workspace.writeFile(path, bytes);
await workspace.readdir(path);
await workspace.stat(path);
await workspace.mkdir(path);
await workspace.deleteFile(path);
await workspace.listFilesUnder(prefix);
await workspace.findFiles(dir, pattern);
await workspace.grep(pattern, path);
```

### Mounts

Mounts are read-only. Writes anywhere under a mount root throw `EROFS`,
and container-side writes under the same path are dropped on the pull.

On first call to any `Workspace` read/write/`exec`/`warmup`, the index for
every configured mount is built (one `list()` per mount). File rows appear
in the VFS as zero-byte stubs whose `stat()` reports the size returned by
`list()`. The first `readFile` (or `grep`, or the pre-`exec` hydration
pass) fetches the bytes and writes them into the VFS chunked storage.

Index state is persisted in the DO's SQLite, so reloads skip the re-list.
Concurrent reads of the same stub share a single in-flight fetch.

Call `workspace.prefetch()` (or `prefetch(root)`) to eagerly hydrate every
stub upfront — useful from `onStart`/`waitUntil` if you want the first
`grep` against a large mount to avoid a cold-start fetch fan-out.

## Running WASM

```ts
import { runWasm } from "@cloudflare/workspace/worker-sandbox";

const result = await runWasm({
  workspace: this.workspace,
  loader:    this.env.LOADER,
  wasmPath:  "/workspace/program.wasm",
  argv:      ["program", "--arg", "value"],
  stdin:     "optional stdin",
});
// { stdout, stderr, exitCode, files, images }
```

Requires a `worker_loaders` binding in `wrangler.jsonc`:

```jsonc
{ "worker_loaders": [{ "binding": "LOADER" }] }
```

## Container

Your sandbox Dockerfile needs the workspace server bundled in:

```dockerfile
FROM cloudflare/sandbox:0.9.2

RUN apt-get update && apt-get install -y --no-install-recommends \
      fuse3 libfuse2 ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY node_modules/@cloudflare/workspace/dist/container-sandbox.cjs           ./server.cjs
COPY node_modules/@cloudflare/workspace/dist/container-sandbox.package.json  ./package.json
RUN npm install --omit=dev

# ... your own tools below (compilers, runtimes, etc.)

EXPOSE 4567
```

The `Workspace` class starts the server automatically via `startProcess()`
the first time you call `exec()` or `warmup()`.
