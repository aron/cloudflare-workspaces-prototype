# Hackspace monorepo

Multiplayer chat workspace built on Cloudflare. An LLM agent runs
inside rooms and threads (addressable by `@mention`) with access to a
DO-backed virtual filesystem that's mirrored into a Sandbox container
over FUSE — the agent's file tools and the container's `exec` see the
same bytes without an explicit sync.

The workspace primitive itself lives upstream now:
[`@cloudflare/computer`](https://github.com/cloudflare/computer),
pinned to `0.1.0-alpha.1`. The Sandbox container runs the matching
prebuilt `computerd` daemon from
[`ghcr.io/cloudflare/computer-computerd-linux-x64:0.1.0-alpha.1`](https://github.com/cloudflare/computer/pkgs/container/computer-computerd-linux-x64).
Both pins move together — see [Upgrading the computer
package](#upgrading-the-computer-package) below.

## Layout

| Path | Package | Description |
|---|---|---|
| [packages/fs-tools](./packages/fs-tools)   | `@cloudflare/fs-tools`  | `read` / `write` / `edit` tools over a pluggable file store. |
| [packages/web-tools](./packages/web-tools) | `@cloudflare/web-tools` | `webfetch` / `websearch` (Brave) tools. |
| [packages/shared](./packages/shared)       | `@app/shared`           | Wire types shared between agent and frontend. |
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
#   BRAVE_API_KEY=…            (omit to disable the websearch tool)
#   ACCESS_DEV_USER={…}        (optional dev identity when Access is off)
npm run dev
```

> ⚠️ `apps/agent/.dev.vars` is loaded by wrangler from the directory of any
> `wrangler*.jsonc` in that folder — including the test config. Keep
> production secrets here; the test runner strips them via a separate
> wrangler config in `tests/wrangler.test.jsonc` plus the agent-suite
> config under `tests/agent-suite/`.

### Behind Cloudflare WARP or a corporate TLS proxy

WARP MITM-decrypts external TLS, so the Sandbox image's `curl`/`npm`
steps fail with "unable to get local issuer certificate" unless the
build context trusts the WARP root. Drop your host bundle at
`apps/agent/ca/warp-ca.crt` (gitignored, host-specific):

```sh
cp /usr/local/share/ca-certificates/extra-ca.crt apps/agent/ca/warp-ca.crt
# (or wherever your WARP / corporate root lives on the host)
```

The Dockerfile picks up any `.crt` under `apps/agent/ca/` and trusts
it via `update-ca-certificates` before any network step. Hosts without
WARP just leave the directory empty and the build behaves identically.

## Deploying

```sh
cd apps/agent
npm run deploy
```

`predeploy` builds the React UI into `apps/frontend/dist/`, which the
worker serves as static assets (configured in
`apps/agent/wrangler.jsonc` via `assets.directory`).

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
  - `Sandbox`, `WarmPool` — pre-warmed container fleet for `exec` and
    `git_clone`. Each `Sandbox` DO owns a `Workspace` + a computerd container;
    the Agent DO pulls a `WorkspaceStub` across DO RPC.
- Container image `hackspace-prototype-sandbox` (pushed to
  `registry.cloudflare.com/<account>/hackspace-prototype-sandbox`).
  Layers a Debian-slim base + the `computerd` SEA binary out of
  `ghcr.io/cloudflare/computer-computerd-linux-x64:0.1.0-alpha.1` + a
  Node 24 toolchain (node, npm, esbuild, wrangler).
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

Smoke tests:

- **node** — ask it to write a small TypeScript or JS program and run
  it via `exec` with `backend: 'container'`. Confirms the Sandbox
  container started and computerd is serving the FUSE-mounted workspace.
- **shell git** — ask it to `git clone` a small public repo, then
  `ls` / `read` the result. Exercises the worker backend's built-in
  git command and the shared SQLite VFS.
- File ops (`read` / `write` / `edit`) and, if `BRAVE_API_KEY` is set,
  `websearch`.

### Common failures

| Symptom | Cause | Fix |
|---|---|---|
| `curl: (60) SSL certificate problem` during the Node download in the Docker build | WARP MITMs TLS, container doesn't trust the cert | Drop your host CA bundle at `apps/agent/ca/warp-ca.crt`. The Dockerfile installs it before the first network step. |
| `failed commit on ref … EOF` mid-push to `registry.cloudflare.com` | WARP throttling large uploads | `warp-cli disconnect`, retry, reconnect. Layer cache resumes. |
| `failed commit on ref … manifest … EOF` at the very end | Same as above on the final manifest PUT | Single retry usually completes — all blobs already uploaded. |
| `websearch` missing from a persona | `BRAVE_API_KEY` unset in prod | `wrangler secret put BRAVE_API_KEY`. |

## Upgrading the computer package

The agent depends on two artefacts that need to move in lockstep:

1. **npm:** `@cloudflare/computer` (pinned in
   `apps/agent/package.json`).
2. **GHCR:** `ghcr.io/cloudflare/computer-computerd-linux-x64:<version>`
   (the `FROM` line in `apps/agent/Dockerfile`).

The `computerd` examples in the upstream
[cloudflare/computer](https://github.com/cloudflare/computer) repo
(particularly `examples/think`) are the source-of-truth for the
tiered backend wiring we use — `WorkerBackend` + `WorkspaceServiceProxy`
for the shell tier, `withWorkspaceContainer` + `CloudflareContainerBackend`
for the container tier.

To bump:

```sh
# 1. pin the npm package
npm install --workspace=@app/agent @cloudflare/computer@<version>

# 2. update the GHCR tag in apps/agent/Dockerfile to match.
#    Look for the `FROM ghcr.io/cloudflare/computer-computerd-linux-x64:` line.

# 3. typecheck + tests + smoke
cd apps/agent && npx tsc --noEmit && npx vitest run
```
