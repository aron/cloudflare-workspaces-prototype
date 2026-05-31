# `@cloudflare/workspace-fs`

Durable Object SQLite-backed virtual filesystem for Cloudflare Workspace.

This package exposes a JavaScript module, not a CLI. It bundles three layers that can be used independently:

- A `Database` wrapper around Durable Object SQL storage plus `initializeSchema` for the `vfs_*` tables.
- Filesystem primitives under `src/fs/*` (`mkdir`, `writeFile`, `readFile`, `rm`, `readdir`, `stat`, `find`, `ls`, `grep`, `symlink`, `readlink`, `gc`, `watch`) operating on a `Database`.
- `SQLiteWorkspaceProvider`, a `@platformatic/vfs` adapter that composes those primitives into a node-shaped filesystem (fd table, positional `readSync`/`writeSync`, `watchSync`, symlinks). This is what `wsd` mounts via FUSE.
- Sync protocol building blocks operating on the same `Database`: `applyChanges`, `stageBlob`, `materialiseChange`, `coalesceChanges`, `fetchChanges`, `fetchObjects`, `hasObjects`, `pushObjects`, `buildManifest`, `currentRev`, `readWatermark`/`writeWatermark`, `assertAppliedPushRev`, and `DEFAULT_IGNORE`/`isIgnored`. The wire wiring lives in `@cloudflare/workspace-rpc`.

Minimal DO-side usage — initialize the schema; the `Database` becomes the handle every other helper takes:

```ts
import { Database, initializeSchema } from "@cloudflare/workspace-fs";

export class WorkspaceDO extends DurableObject {
  private readonly db: Database;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = new Database(ctx.storage);
    initializeSchema(this.db, Date.now);
  }
}
```

> The `src/fs/*` primitives (`mkdir`, `writeFile`, `readFile`, `rm`, `readdir`, `stat`, `find`, `ls`, `grep`, `symlink`, `readlink`, `gc`, `watch`) are not re-exported from the package root yet — they are consumed in-tree by `SQLiteWorkspaceProvider` and by the sync `applyChanges` path. On the node side, instantiate `SQLiteWorkspaceProvider` (the `@platformatic/vfs` adapter) for a familiar node:fs-shaped surface; this is what `@cloudflare/workspace-wsd` mounts via FUSE. A higher-level DO-side `Workspace` class with the `fs`/`shell`/`push`/`pull` surface described in [`../../docs/README.md`](../../docs/README.md) is still future work — see [`../../PLAN.md`](../../PLAN.md).

## API shape

Naming decisions relative to `docs/04_filesystem_interface.md`:

- `findFiles` is exposed as `find`.
- `listFilesUnder` is exposed as `ls`.

Implementation status:

- `Database` wrapper around Durable Object SQL storage in place.
- Schema initialization for the documented `vfs_*` tables (FS and sync) implemented and split into `schema/core.ts` + `schema/sync.ts`.
- `incrementRev()` shared sequencer in place. FS writes stamp the returned value into `vfs_nodes.rev` and pass it to `sync/changes.ts` for tombstones.
- `SQLiteTestStorage` (backed by `node:sqlite`) available from `./testing` for unit tests against a real in-memory database; `RecordingStorage` available from the package root for workerd-safe schema assertions.
- All filesystem primitives listed above are implemented and unit-tested.
- `SQLiteWorkspaceProvider` (the `@platformatic/vfs` adapter) implemented and exported from the package entrypoint; consumed by `@cloudflare/workspace-wsd`.
- Sync protocol building blocks implemented and exported; the typed RPC surface on top of them lives in `@cloudflare/workspace-rpc`.
