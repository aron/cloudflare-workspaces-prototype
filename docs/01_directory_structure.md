# 01. Directory Structure

> [!IMPORTANT]
> This document describes the **intended design** and has **diverged
> from the current implementation** in the repository. Names,
> signatures, and behaviours described here are targets, not what
> `main` ships today. When in doubt, treat the code as authoritative
> for what runs and this doc as authoritative for what we're moving
> toward.

The workspace exposes a single absolute path namespace rooted at `/`. By
convention everything lives under `/workspace`, but the root is
configurable — pass `root` to the `Workspace` constructor to anchor the
tree somewhere else. Inside the sandbox container the same tree is
mounted on the host filesystem at the same path via FUSE, so paths on
both sides of the wire match byte-for-byte.

```ts
new Workspace({
  storage:   ctx.storage,
  sandbox:   env.Sandbox,
  sessionId: ctx.id.name,
  root:      "/workspace",   // default; override to e.g. "/srv" or "/home/agent"
});
```

With the default `root`:

```
/                              # VFS root (do not write here)
└── /workspace                 # the configured `root`
    ├── /workspace/.agents     # only present if you mount something here
    │   └── /workspace/.agents/skills    # typical R2 mount target
    ├── /workspace/project     # typical GitHub mount target
    ├── /workspace/documentation
    └── ...                    # everything else is user-defined
```

The root path is created automatically on first boot; everything below
it is yours to shape.

## Conventions

- **Absolute paths only.** Every fs and shell call takes an absolute path
  starting with `/`. Relative paths are rejected with `EINVAL`. Resolve
  paths against `process.cwd()` (or the `cwd` option on `shell.exec`) at
  the call site if you need relative semantics.
- **Forward slashes.** Paths are POSIX-style. Backslashes are not
  separators.
- **No trailing slash.** `/workspace/foo` and `/workspace/foo/` are the
  same directory; the canonical form has no trailing slash. The root `/`
  is the one exception.
- **Reserved root.** `/` itself cannot be deleted (`EPERM`). Mount roots
  cannot be deleted either — remove the mount from `WorkspaceOptions`
  instead.

## Mount roots

A mount is anchored at an absolute path inside the workspace. The path is
the *mount root* and behaves like a directory created by `mkdir`. The
contents under it are sourced from the mount provider on first read.

- Mount roots must be absolute and must not nest. A mount at
  `/workspace/a` and another at `/workspace/a/b` is rejected at construction.
- Read-only mounts (the default) reject all writes under their root with
  `EROFS`. Read-write mounts mirror writes back to the provider.
- Writes that originate from `shell.exec` under a read-only mount are
  silently dropped on the post-exec pull (see [02. Sync Protocol](./02_sync_protocol.md)).

## Reserved paths

| Path | Notes |
| --- | --- |
| `/` | VFS root. Never delete. Treat as read-only. |
| `root` (default `/workspace`) | The configured workspace root. Created automatically. Cannot be deleted. |
| Mount roots | Cannot be deleted while the mount is configured. Remove the mount from `WorkspaceOptions` instead. |
| `/tmp` (container only) | Not part of the VFS. Lives in the container's own filesystem and is wiped on container restart. |

Paths like `/workspace/.agents/skills` aren't reserved — they only exist
because a mount was configured at that path. Without the mount, the path
is unremarkable, and you're free to use any naming convention you like
for your own data.

## Sandbox view

When the workspace boots a sandbox container, the VFS is mounted at
`MOUNT_POINT` (default `/workspace`) via FUSE. Inside the container:

- Reads route through the FUSE driver to the in-container VFS mirror.
- Writes are recorded as dirty in the mirror and pulled back to the DO
  after the next `exec()` completes, or whenever you explicitly call
  `workspace.pull()`. The matching `workspace.push()` flushes pending
  DO-side writes to the container without waiting for the next `exec()`.
  Use them when you need to synchronize the two sides outside of a
  command run — e.g. before reading a file from the container directly,
  or after a batch of DO-side writes that another process will observe.
- Container-local paths *outside* the mount (e.g. `/usr`, `/tmp`,
  `/app`) are the container's own filesystem and are not synced.

See [06. Mount Interface](./06_mount_interface.md) for mount semantics and
[02. Sync Protocol](./02_sync_protocol.md) for how the two trees stay in sync.
