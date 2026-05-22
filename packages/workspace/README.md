# @cloudflare/workspace

A Durable-Object-backed virtual filesystem that syncs incrementally with a
`@cloudflare/sandbox` container, plus a helper for running compiled WASM in
isolated Cloudflare Dynamic Workers.

Three entry points:

| Entry | Purpose |
|---|---|
| `@cloudflare/workspace`                  | DO-side: the `Workspace` class. |
| `@cloudflare/workspace/worker-sandbox`   | `runWasm()` — execute a WASM binary in a Dynamic Worker. |
| `@cloudflare/workspace/container-sandbox`| Pre-built container server (`COPY` it into your Dockerfile). |
| `@cloudflare/workspace/shared`           | Wire types and the capnweb RPC interface. |

## DO-side

```ts
import { Workspace } from "@cloudflare/workspace";

export class MyAgent extends DurableObject {
  workspace: Workspace;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.workspace = new Workspace({
      storage:   ctx.storage,
      sandbox:   env.Sandbox,
      sessionId: ctx.id.name ?? ctx.id.toString(),
    });
  }

  async someMethod() {
    this.workspace.writeFile("/workspace/main.zig", "...");
    const result = await this.workspace.exec(
      "zig build-exe /workspace/main.zig -target wasm32-wasi",
    );
    return result.stdout;
  }
}
```

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
