# `@cloudflare/workspace`

Durable Object-side facade for a Cloudflare Workspace. Pairs a local
SQLite-backed VFS (via `@cloudflare/dofs`) with a sync connection to
a `wsd` instance through a pluggable backend.

The public surface lives on three classes:

- `Workspace` — the host-side facade. Owns the local store, the
  backend handle, and the push/pull bracket.
- `WorkspaceStub` — what `workspace.stub()` returns, designed to
  cross the Workers-RPC boundary into another Worker or DO.
- `WorkspaceShell` / `ExecHandle` — the command-execution half of
  the API.

Typical DO-side usage:

```ts
import { Workspace, CloudflareContainerBackend } from "@cloudflare/workspace";
import { DurableObject } from "cloudflare:workers";

export class WsdContainer extends DurableObject<Env> {
  #workspace = new Workspace({
    storage: this.ctx.storage,
    backends: [
      new CloudflareContainerBackend({
        container: () => this.ctx.container!,
        egress: this.ctx.exports.WsdEgress({ props: { id: this.ctx.id.toString() } }),
      }),
    ],
  });

  async getWorkspace(): Promise<WorkspaceStub> {
    await this.#workspace.ready();
    return this.#workspace.stub();
  }
}
```

Worker-side consumption:

```ts
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const id = env.WSD.idFromName("user-123");
    using ws = await env.WSD.get(id).getWorkspace();

    await ws.fs.writeFile("/notes.md", "hello");
    using handle = await ws.shell.exec("ls /workspace");
    const { exitCode, stdout } = await handle.result();

    return new Response(stdout, { status: exitCode === 0 ? 200 : 500 });
  },
} satisfies ExportedHandler<Env>;
```

## Stub disposal

capnweb does not garbage-collect remote stubs. On the long-lived
sessions this package depends on (Worker ↔ DO over Workers RPC,
DO ↔ wsd over capnweb), undisposed stubs accumulate on the peer
side until the session ends.

The minimum a caller needs to know:

- `using` the value returned from `env.WSD.get(id).getWorkspace()`.
- `using` the handle returned from `ws.shell.exec(...)`.
- Don't worry about `ws.fs` / `ws.shell` — those are property
  accessors that ride with the parent.
- Pure-value returns (`readFile` as a string, `stat`, `readdir`,
  etc.) carry no stubs; nothing to dispose.

Short-lived single-shot Workers (one `getWorkspace()`, a few calls,
return a response) tear the session down with the request, so the
discipline matters most on long-lived isolates that keep grabbing
fresh `WorkspaceStub`s or on busy `exec` workloads inside a single
request.

The full contract — including the boundary between the driver code
and direct streaming callers, and how it interacts with hibernation
and reconnect — is in [`docs/11_lifecycle.md`](../../docs/11_lifecycle.md#stub-disposal-contract).

Leak discovery: set `CAPNWEB_TRACK_STUBS=1` and read the snapshot
via `stubSnapshot()` from `@cloudflare/workspace-rpc/debug`, or
hit `GET /__wsd/stubs` on a wsd instance. The soak scripts at
[`script/wsd-stub-soak.mjs`](../../script/wsd-stub-soak.mjs) and
[`tests/stub-soak.test.ts`](./tests/stub-soak.test.ts) exercise both
boundaries.
