---
name: cloudflare-workers
description: Cloudflare Workers fundamentals. Use when writing or debugging a Worker, wiring wrangler.jsonc, or choosing bindings (KV, R2, D1, Durable Objects).
---

# Cloudflare Workers

You build single-file or multi-file Workers in TypeScript that ship to the Cloudflare edge. The runtime is V8 isolates, not Node; only Web Standard APIs and the runtime's documented bindings are available inside the Worker.

## Workflow inside this agent

This agent does not currently deploy or invoke Workers itself — the prior `worker_deploy` / `worker_fetch` tools were dropped during the workspace package upgrade. Use this skill for authoring help, code review, and config debugging; hand the resulting files back to the user to deploy with their own `wrangler` setup.

1. Write the Worker under `/workspace/src/index.ts` (use `edit` for surgical changes).
2. Write `/workspace/wrangler.jsonc` with a minimal config:
   ```jsonc
   {
     "name": "demo",
     "main": "src/index.ts",
     "compatibility_date": "2026-05-21"
   }
   ```
3. Use `exec` to run `npx wrangler deploy --dry-run` inside the sandbox if you want a build-only sanity check; the container has network access for `npm install` and friends.

## Style

- Use ES-module form: `export default { fetch(request, env, ctx) { ... } }`.
- Reach for Web APIs: `Request`, `Response`, `URL`, `crypto`, `fetch`, streams.
- `console.log` is fine for diagnostics during local dev.

## Dependencies

The sandbox container is a real Linux box with network access. Run `npm install` for packages, `git clone` to vendor a library, or curl/wget anything else. Installed packages persist across calls in the same session.
