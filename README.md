# Cloudflare Workspaces Prototype

This repository hosts the Cloudflare Workspace prototype as a small monorepo:

- [`packages/dofs`](packages/dofs/README.md) (`@cloudflare/dofs`) — Durable Object SQLite-backed virtual filesystem, sync protocol building blocks, and a `@platformatic/vfs` provider for Node.
- [`packages/rpc`](packages/rpc/README.md) (`@cloudflare/workspace-rpc`) — capnweb-based RPC wire types and server/client helpers shared between the DO and `wsd`.
- [`packages/wsd`](packages/wsd/README.md) (`@cloudflare/workspace-wsd`) — the `wsd` daemon: a FUSE mount plus HTTP/WebSocket RPC server that runs inside the sandbox container.
- [`packages/workspace`](packages/workspace/README.md) (`@cloudflare/workspace`) — the top-level Workspace package consumed by Durable Objects. Still a work in progress; see [`docs/README.md`](docs/README.md) for the intended design (note: that document is forward-looking and has diverged from `main`).

See [`PLAN.md`](PLAN.md) for the implementation roadmap and [`AGENTS.md`](AGENTS.md) for contributor guidelines.
