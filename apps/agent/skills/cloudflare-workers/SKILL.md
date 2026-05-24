---
name: cloudflare-workers
description: Cloudflare Workers fundamentals. Use when writing or debugging a Worker, wiring wrangler.jsonc, choosing bindings (KV, R2, D1, Durable Objects), or testing a Worker via worker_deploy/worker_fetch.
---

# Cloudflare Workers

You build single-file or multi-file Workers in TypeScript that ship to the Cloudflare edge. The runtime is V8 isolates, not Node; only Web Standard APIs and the runtime's documented bindings are available inside the Worker.

## Workflow inside this agent

1. Write the Worker under `/workspace/src/index.ts` (use `edit` for surgical changes).
2. Write `/workspace/wrangler.jsonc` with a minimal config:
   ```jsonc
   {
     "name": "demo",
     "main": "src/index.ts",
     "compatibility_date": "2026-05-21"
   }
   ```
3. Call `worker_deploy` with `{ config: "/workspace/wrangler.jsonc" }` — it runs `wrangler deploy --dry-run`, captures the build log, and loads the bundle into a fresh Dynamic Worker.
4. Call `worker_fetch` with a static `fetch(...)` call to exercise the loaded Worker.

## wrangler.jsonc

Supported in this environment:

- `main`, `compatibility_date`, `compatibility_flags`
- `vars` (plain object appears on `env` inside the Worker)

Not wired up:

- KV, R2, D1, Durable Object bindings — the loaded Worker has none.
- Routes, custom domains, workers.dev settings — ignored.
- Secrets — use `vars` for testing instead.

## Style

- Use ES-module form: `export default { fetch(request, env, ctx) { ... } }`.
- Reach for Web APIs: `Request`, `Response`, `URL`, `crypto`, `fetch`, streams.
- The deployed Worker has `globalOutbound: null`, so `fetch()` from inside the Worker rejects. The build container's network access is unaffected.
- `console.log` is fine for diagnostics; output is not included in `worker_fetch`'s response.

## worker_fetch call shape

Only static literals are accepted (no variables, no function calls, no spreads):

```
worker_fetch({ request: "fetch('https://w/users')" })
worker_fetch({ request: "fetch('https://w/api', { method: 'POST', body: '{\"a\":1}', headers: { 'content-type': 'application/json' } })" })
```

Returns `{ status, statusText, headers, body, bodySize, bodyMime, durationMs }`. Binary responses come back with `bodyOmitted: true`; text bodies past 64 KB are truncated.

## Dependencies

The build container is a real Linux box with network access. Run `npm install` for packages, `git clone` to vendor a library, or curl/wget anything else before invoking `worker_deploy`. Installed packages persist across calls in the same session.
