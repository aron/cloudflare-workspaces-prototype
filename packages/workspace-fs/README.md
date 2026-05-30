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

Initial implementation status:

- Package scaffold and public types are in place.
- Durable Object SQL storage adapter is started.
- Schema initialization for the documented `cf_vfs_*` tables is started.
- Filesystem behavior beyond initialization is not implemented yet.
