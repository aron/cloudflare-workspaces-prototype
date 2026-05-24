# Hackspace monorepo

Multiplayer chat workspace built on Cloudflare. Pairs a `Workspace`
primitive — DO-backed virtual filesystem with two-way sync to a Sandbox
container plus WASM execution via Dynamic Workers — with an LLM agent
that runs inside rooms and threads, addressable by `@mention`.

## Layout

| Path | Package | Description |
|---|---|---|
| [packages/workspace](./packages/workspace) | `@cloudflare/workspace` | DO-backed VFS + Sandbox sync + WASM runner. |
| [packages/fs-tools](./packages/fs-tools)   | `@cloudflare/fs-tools`  | `read` / `write` / `edit` tools over a pluggable file store. |
| [packages/web-tools](./packages/web-tools) | `@cloudflare/web-tools` | `webFetch` / `webSearch` (Brave) tools. |
| [packages/shared](./packages/shared)       | `@app/shared`           | Wire types shared between agent + frontend. |
| [apps/agent](./apps/agent)                 | `@app/agent`            | The Worker: Agent / SubAgent / App / Room / Sandbox / WarmPool DOs. |
| [apps/frontend](./apps/frontend)           | `@app/frontend`         | Vite-built React UI served as static assets from the agent worker. |

## Development

```sh
npm install            # installs all workspaces
npm run build          # builds every workspace
npm run typecheck      # tsc --noEmit across the monorepo
npm run test           # vitest, all workspaces (uses vitest-pool-workers for the agent)
```

The agent has two in-process test suites and a separate E2E suite:

```sh
cd apps/agent
npm run test           # both in-process suites (App/Room/identity + Agent/SubAgent/personas)
npm run test:e2e       # E2E driving a real `wrangler dev` (slow, needs Docker)
```

## Running locally

```sh
cd apps/agent
cp .dev.vars.example .dev.vars
# Edit .dev.vars:
#   OPENAI_API_KEY=…           (omit to use the Workers AI fallback)
#   BRAVE_API_KEY=…            (omit to disable the webSearch tool)
#   ACCESS_DEV_USER={…}        (optional dev identity when Access is off)
npm run dev
```

> ⚠️ `apps/agent/.dev.vars` is loaded by wrangler from the directory of any
> `wrangler*.jsonc` in that folder — including the test config. Keep
> production secrets here; the test runner strips them via a separate
> wrangler config in `tests/wrangler.test.jsonc` plus the agent-suite
> config under `tests/agent-suite/`.

## Deploying

```sh
cd apps/agent
npm run deploy
```

`predeploy` runs three steps automatically:

1. **`sandbox/sync-host-ca.sh`** — stages your host CA bundle
   (`$SSL_CERT_FILE` → `$NODE_EXTRA_CA_CERTS` → `$REQUESTS_CA_BUNDLE`)
   into `apps/agent/sandbox/host-ca.crt` so the Sandbox container build
   trusts the same roots as your host. Required when you're behind
   Cloudflare WARP or a corporate TLS-intercepting proxy. No-op if none
   of those env vars are set. The staged cert is gitignored.
2. **`npm run build --workspace=@cloudflare/workspace`** — builds the
   workspace primitive that the agent and the Sandbox container both
   consume.
3. **`npm run build --workspace=@app/frontend`** — Vite-builds the React
   UI into `apps/frontend/dist/`, which the worker serves as static
   assets (configured in `apps/agent/wrangler.jsonc` via
   `assets.directory`).

### Prerequisites on the deploying machine

- Docker daemon running (the Sandbox container is built from
  `apps/agent/Dockerfile` and pushed to the Cloudflare registry).
- `wrangler whoami` succeeds (account creds available, e.g. via
  `wrangler login` or `CLOUDFLARE_API_TOKEN` in `.dev.vars`).
- If you're behind Cloudflare WARP, **disconnect WARP for the registry
  push** (`warp-cli disconnect`). WARP routinely interrupts long uploads
  with `EOF`. Layer caching means a partial push can be resumed cleanly
  on retry. Reconnect (`warp-cli connect`) once the deploy finishes.

### What gets deployed

- Worker `hackspace-prototype` (Cloudflare account `…b8a…`).
- Durable Objects:
  - `Agent`, `SubAgent` — chat fibers; one Agent per thread.
  - `App` — singleton; rooms list, identity echo (`/api/app/*`).
  - `Room` — one per chat room; WS fanout, thread minting on
    `@mention` (`/api/rooms/:id/*`).
  - `Sandbox`, `WarmPool` — pre-warmed container fleet for `exec`/`run`.
- Container image `hackspace-prototype-sandbox` (pushed to
  `registry.cloudflare.com/<account>/hackspace-prototype-sandbox`).
- Cron `* * * * *` — primes the warm pool every minute. Drop the
  `triggers.crons` block in `wrangler.jsonc` if you want manual priming.

### Production secrets

`wrangler.jsonc` only declares plain vars (warm pool sizing, Access
config). Real secrets ride on `wrangler secret put`:

```sh
wrangler secret put OPENAI_API_KEY
wrangler secret put BRAVE_API_KEY
# When enabling Access:
wrangler secret put ACCESS_AUD
# (ACCESS_TEAM_DOMAIN can stay in wrangler.jsonc vars)
```

### Verifying

```sh
curl -I  https://hackspace-prototype.<account>.workers.dev/
curl     https://hackspace-prototype.<account>.workers.dev/personas
npx wrangler tail   # follow logs while you exercise the UI
```

Per-persona smoke tests:

- **cloudflare-worker** — ask it to build a tiny Worker and call
  `worker_deploy` + `worker_fetch`.
- **zig** / **go** — ask it to write, compile (`exec`) and run (`run`)
  a small program. Confirms the Sandbox container started and the WASM
  Dynamic Worker loader is wired.
- Any persona — file ops (`read`/`write`/`edit`) and, if `BRAVE_API_KEY`
  is set, `webSearch`.

### Common failures

| Symptom | Cause | Fix |
|---|---|---|
| `curl: (60) SSL certificate problem` during Zig/Go download in Docker build | WARP MITMs TLS, container doesn't trust the cert | Ensure `$SSL_CERT_FILE` (or `$NODE_EXTRA_CA_CERTS` / `$REQUESTS_CA_BUNDLE`) points at your host CA bundle; predeploy stages it. |
| `failed commit on ref … EOF` mid-push to `registry.cloudflare.com` | WARP throttling large uploads | `warp-cli disconnect`, retry, reconnect. Layer cache resumes. |
| `failed commit on ref … manifest … EOF` at the very end | Same as above on the final manifest PUT | Single retry usually completes — all blobs already uploaded. |
| `webSearch` missing from a persona | `BRAVE_API_KEY` unset in prod | `wrangler secret put BRAVE_API_KEY`. |
