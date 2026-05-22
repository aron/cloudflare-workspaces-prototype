# Workspace monorepo

A reusable `Workspace` primitive for Cloudflare Workers — DO-backed virtual filesystem with two-way sync to a Sandbox container, plus WASM execution via Dynamic Workers — alongside a reference agent that uses it.

## Packages

| Package | Description |
|---|---|
| [packages/workspace](./packages/workspace) | `@cloudflare/workspace` — the reusable primitive. |
| [apps/agent](./apps/agent) | An LLM-driven chat agent that writes Zig, compiles it to WASM, and runs it. |

## Development

```sh
npm install
npm run build       # builds every workspace
npm run typecheck   # tsc --noEmit across the monorepo
```

To run the demo agent locally:

```sh
cd apps/agent
cp .dev.vars.example .dev.vars
# … edit .dev.vars with OPENAI_API_KEY (or omit for Workers AI) …
npm run dev
```

To deploy:

```sh
cd apps/agent
npm run deploy
```

`predeploy` builds the workspace package and the UI bundle, so a fresh
clone deploys correctly without manual build steps.
