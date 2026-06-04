# Cloudflare Workspace

Cloudflare Workspace is a virtual filesystem that lives inside a Durable
Object and projects itself into a sandbox container as a real FUSE
mount. The Durable Object holds the authoritative state in SQLite; a
sandbox-side daemon (`wsd`) mounts that state as a filesystem and syncs
changes back over a capnweb RPC channel.

> **Status: prototype.** APIs are unstable and the design is still
> moving. The specification under [`docs/`](docs/) is forward-looking
> and has diverged from `main` in places — read it for intent, not as a
> description of the code today.

## Requirements

- Node 22 or newer.
- npm. This repo uses npm workspaces.
- Linux with FUSE if you want to run `packages/wsd` end-to-end. Other
  packages build and test on macOS as well.
- Docker, optionally, for [`examples/wsd-container`](examples/wsd-container).

## Quick start

```bash
git clone https://github.com/cloudflare/workspace.git
cd workspace
npm install
npm run build:all
npm test
```

To see the pieces working together, start with the examples:

- [`examples/wsd-container`](examples/wsd-container) — runs `wsd`
  inside a container, mounts a workspace, and talks to a Durable
  Object over capnweb.
- [`examples/think`](examples/think) — an agent that uses the
  workspace as its working directory.

## Repository layout

The repo is a small monorepo. Each package has its own README with
package-specific status and usage notes.

- [`packages/dofs`](packages/dofs/README.md) (`@cloudflare/dofs`) —
  Durable Object SQLite-backed virtual filesystem, sync protocol
  building blocks, and a `@platformatic/vfs` provider for Node.
- [`packages/rpc`](packages/rpc/README.md)
  (`@cloudflare/workspace-rpc`) — capnweb wire types and
  server/client helpers shared between the Durable Object and `wsd`.
- [`packages/wsd`](packages/wsd/README.md)
  (`@cloudflare/workspace-wsd`) — the `wsd` daemon: a FUSE mount plus
  HTTP/WebSocket RPC server that runs inside the sandbox container.
- [`packages/workspace`](packages/workspace/README.md)
  (`@cloudflare/workspace`) — the top-level Workspace package
  consumed by Durable Objects. Work in progress.

## Documentation

- [`docs/`](docs/README.md) — design specification. Forward-looking;
  treat as intent.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for setup, formatting,
testing, commit message, and pull request conventions.

If you're working in this repo as an agent, start with
[`AGENTS.md`](AGENTS.md) and the skills under
[`.agents/skills/`](.agents/skills/).
