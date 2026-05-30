# 10. Project Layout

> [!IMPORTANT]
> This document describes the **intended design** and has **diverged
> from the current implementation** in the repository. Names,
> signatures, and behaviours described here are targets, not what
> `main` ships today. When in doubt, treat the code as authoritative
> for what runs and this doc as authoritative for what we're moving
> toward.

The workspace ships as a monorepo. The package itself lives in
`packages/workspace`; the agent-facing tooling sits alongside it.

```
workspace/
├── packages/
│   ├── workspace/         # @cloudflare/workspace — VFS + container sync
│   ├── fs-tools/          # @cloudflare/fs-tools — AI SDK read/write/edit/grep/exec tools
│   ├── git-tools/         # Git-related agent tools
│   └── internal/          # Cross-package shared types and helpers
├── docs/                  # This documentation set
└── package.json           # Workspace root
```

## `packages/workspace`

The production implementation of the package documented in this set.

```
packages/workspace/
├── src/
│   ├── index.ts                     # Public entrypoint: Workspace, mounts, types
│   ├── workspace.ts                 # Workspace class — DO-side facade
│   ├── vfs.ts                       # SQLite-backed VFS (schema, migrations, IO)
│   ├── path.ts                      # Path parsing and canonicalization
│   ├── serialize.ts                 # Per-Workspace FIFO mutex
│   ├── pull-assembly.ts             # Manifest pull: hash union, byte assembly
│   ├── container-connection.ts      # DO-side capnweb client
│   ├── container-startup.ts         # workspace-server probe / start / wait logic
│   ├── shared/                      # Wire types and ContainerRPC interface
│   ├── mounts/                      # Built-in mount providers and the Mount API
│   └── container-sandbox/           # Bundled into the published `ws.js`
├── examples/                        # Minimal usage examples
├── scripts/                         # Build pipeline (esbuild + tsc)
└── package.json                     # Two exports: `.` and `/shared`
```

Tests live next to the source they cover — `vfs.ts` sits beside
`vfs.test.ts`, `mounts/r2.ts` beside `mounts/r2.test.ts`, and so on.
Cross-cutting integration tests that exercise multiple packages or
require a sandbox harness live in `tests/` at the package root.

### Build outputs

`npm run build` produces, in `dist/`:

- `index.js` + `.d.ts` — the DO-side entrypoint.
- `ws.js` — the injected service. A single pre-built script, ready to
  `COPY` into a sandbox image (see
  [07. Injected Service](./07_injected_service.md)).
- `shared.js` + `shared/index.d.ts` — wire types and `ContainerRPC`.

## `packages/fs-tools`

AI SDK tools (`read`, `write`, `edit`, `grep`, `exec`) plus the
`FileStore` abstraction the file-shaped ones drive. See
[09. Tool Interface (Agents)](./09_tool_interface.md).

```
packages/fs-tools/
├── src/        # tools, stores, diff helpers (tests live alongside)
└── package.json
```

## `packages/git-tools`

Git-related agent tools (clone, branch inspection, diff). Same shape
as `fs-tools` — `src/` with tests alongside.

## `packages/internal`

Cross-package types and helpers used by the other packages. Not
published; treat it as an implementation detail of the monorepo.

## Testing

- **Unit tests.** `vitest`, with tests living alongside the source
  they cover (`foo.ts` next to `foo.test.ts`).
- **Integration tests.** Cross-package and sandbox-driven scenarios
  live in each package's `tests/` directory. End-to-end coverage uses
  a dedicated harness that boots a real sandbox container and exercises
  the full DO ↔ container round-trip.

## Tooling

- **TypeScript.** `tsc` is the source of truth for types and the
  build. Every package has a `tsconfig.json` extending the workspace
  root config.
- **Biome.** Linting and formatting are handled by
  [Biome](https://biomejs.dev/) (`biome check`, `biome format`). No
  ESLint, no Prettier. The root config is shared across every package.
- **esbuild.** Used to produce the single-file `ws.js` bundle for the
  injected service. Application bundling is left to consumers.
