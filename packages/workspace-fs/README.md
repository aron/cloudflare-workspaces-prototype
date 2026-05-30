# `@cloudflare/workspace-fs`

Durable Object SQLite-backed virtual filesystem for Cloudflare Workspace.

This package exposes a JavaScript module, not a CLI. Pass a Durable Object
storage object to `createWorkspaceFilesystem()` and receive an object that
implements the workspace filesystem API.

```ts
import { createWorkspaceFilesystem } from "@cloudflare/workspace-fs";

export class WorkspaceDO extends DurableObject {
  fs: ReturnType<typeof createWorkspaceFilesystem>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.fs = createWorkspaceFilesystem(ctx.storage);
  }

  async fetch(): Promise<Response> {
    await this.fs.writeFile("/workspace/hello.txt", "hello\n");
    return new Response(await this.fs.readFile("/workspace/hello.txt", "utf8"));
  }
}
```

## API shape

The package-level filesystem interface is derived from `docs/04_filesystem_interface.md`
with two naming decisions applied:

- `findFiles` is exposed as `find`.
- `listFilesUnder` is exposed as `ls`.

Implementation status:

- Package scaffold and public types in place.
- Durable Object SQL storage adapter (`Database` wrapper) implemented.
- Schema initialization for the documented `cf_vfs_*` tables (FS and sync) implemented and split into `schema/core.ts` + `schema/sync.ts`.
- `incrementRev()` shared sequencer in place; FS writes will stamp the returned value into `cf_vfs_nodes.rev` and pass it to `sync/changes.ts` for tombstones.
- `SqliteTestStorage` (backed by `node:sqlite`) available from `./testing` for unit tests against a real in-memory database.
- Filesystem methods (`readFile`, `writeFile`, `rm`, `mkdir`, `readdir`, `stat`, `find`, `ls`, `grep`) are scaffolded but not yet implemented — see [`../../PLAN.md`](../../PLAN.md) for the implementation roadmap.
