# `@cloudflare/think` triage example

A small end-to-end example that uses [`@cloudflare/think`][think] and
[`agents/workflows`][workflows] to triage a GitHub issue. The agent
runs inside a [Cloudflare Container][containers] holding a
[`@cloudflare/workspace`][workspace] VFS; the workflow drives it
through one explore step (full toolset — the model decides whether
to attempt a fix or just gather findings), one tool-less structure
step that coerces the explore output into a zod schema, and a
terminal step that POSTs a unified diff back to the user.

[think]: https://www.npmjs.com/package/@cloudflare/think
[workflows]: https://developers.cloudflare.com/workflows/
[containers]: https://developers.cloudflare.com/durable-objects/containers/
[workspace]: ../../packages/workspace

## Shape

```
client (./triage)                worker                                   container
   │  POST /issue                   │                                         │
   ├──────────────────────────────▶ │  setContext + runWorkflow               │
   │                                ├──── TRIAGE_WORKFLOW ────────────────────▶   │
   │                                │     fetch-issue                          │
   │                                │     → set-phase:explore                  │
   │                                │     → explore  (tools, agentic loop) ──▶ wsd
   │  POST /webhook (progress)      │                                         │
   │  ◀───────────────────────────  │                                         │
   │                                │     → set-phase:structure                │
   │                                │     → structure  (step.prompt, no tools) │
   │                                │     → build-patch  (git diff via vfs)    │
   │  POST /webhook (DONE + patch)  │     → notify-done                         │
   │  ◀───────────────────────────  │                                         │
```

The worker exposes one route, `POST /issue`, with body
`{ issue_url, webhook_url }`. It derives a stable DO name from the
issue, binds the webhook into the agent, and starts the workflow. The
CLI runs that webhook server on `0.0.0.0` so a containerised worker can
reach it back over the host network.

## Tools

The agent has two phases. The workflow flips between them via
`agent.setPhase("explore" | "structure")` inside a `step.do` before
each model step, so a replay after a crash still ends up in the
right phase. `explore` has the full toolset; `structure` has none —
the model can't be tempted to keep calling tools when its job is to
just emit JSON.

| Tool            | Source                                    |
| --------------- | ----------------------------------------- |
| `git_clone`     | `src/tools/git/clone.ts` (isomorphic-git) |
| `read`          | vendored from `hackspace/fs-tools`        |
| `ls`            | `src/agent.ts`                            |
| `write`         | vendored from `hackspace/fs-tools`        |
| `edit`          | vendored from `hackspace/fs-tools`        |
| `exec`          | `src/tools/exec.ts`                       |
| `report_update` | `src/tools/report-update.ts`              |

`git_clone` writes to the workspace through a `@platformatic/vfs`
`VirtualFileSystem` over `Workspace.provider()` — the same `node:fs`-
shaped surface wsd uses for its FUSE mount. The dofs
`SQLiteWorkspaceProvider` underneath implements every method
isomorphic-git asks for, symlinks included, so a clone of e.g.
`cloudflare/sandbox-sdk` (which has symlinks in its tree) checks
out cleanly. The clone runs entirely inside the Worker isolate; the
packfile has to fit in workerd's heap, which is fine for small to
medium repos at `depth: 1` (the default) but not for huge monorepos.
No Cloudflare Artifacts binding required.

## R2-mounted skill

The DO mounts an R2 bucket (`R2_SKILLS`) at `/workspace/.agents` via
`R2Bucket(env.R2_SKILLS, { prefix: ".agents/" })`. On the first call
into the workspace the indexer pages through the bucket and streams
every object into `vfs_nodes`; from then on the agent sees
`/workspace/.agents/skills/triage/SKILL.md` like any other file. The
mount is read-only — writes under `/workspace/.agents` reject with
`EROFS`.

The system prompt tells the model to read that file before it
starts, so the playbook (clone, decide bet, fix or write findings,
report progress, summary contract) is delivered in-band instead of
being baked into the prompt.

Seed the bucket once with the bundled fixture before running:

```sh
# Local miniflare bucket — use this with `wrangler dev`.
npm run seed:r2:local --workspace @cloudflare/example-think

# Real Cloudflare R2 bucket — use this after `wrangler deploy`.
npm run seed:r2 --workspace @cloudflare/example-think
```

The fixture lives at
`examples/think/seed/r2-skills/.agents/skills/triage/SKILL.md`; edit
it and re-run the seed script to update the bucket. The DO picks the
new bytes up on the next session (eager mount, indexed once per
workspace lifetime).

## Running it locally

```sh
# From the repo root:
npm install
npm run build:wsd --workspace @cloudflare/example-think

# Two terminals — worker on one, CLI on the other.
cd examples/think
npm run dev                                            # terminal 1
./cli/triage.mjs https://github.com/owner/repo/issues/42   # terminal 2
```

The CLI prints progress lines as they arrive, then the final commit
subject/body and a colourised unified diff. It exits 0 when the
worker emits a message ending in `DONE`.

Useful flags:

- `--worker URL` — point the CLI at a different worker base URL (also
  `TRIAGE_WORKER`). Default `http://127.0.0.1:8787`.
- `--host HOST` — host name the worker should call back on (also
  `TRIAGE_HOST`). Defaults to the first non-loopback IPv4. Override
  this if you're running the worker inside a container or VM and the
  auto-pick is wrong for that network.

## Configuration

The worker is configured in [`wrangler.jsonc`](./wrangler.jsonc):

- `AI` — Workers AI binding (model: `@cf/moonshotai/kimi-k2.6`).
- `TriageAgent` — container-enabled DO that owns one Workspace + one
  Think agent per issue.
- `TRIAGE_WORKFLOW` — workflow binding pointing at `TriageWorkflow`.

No GitHub auth, no Artifacts. The issue must be on a public
repository.

## Deploying

`wrangler deploy` works against any account that has Workers AI,
Workflows, and Cloudflare Containers enabled. After deploy, the CLI's
webhook URL must be reachable from your worker — use a tunnel
(`cloudflared tunnel`, `ngrok http`, etc.) and pass `--host` so the
CLI advertises the tunnel hostname instead of its local IP.

## What this example deliberately doesn't do

- Private repos / GitHub auth.
- Write back to the issue (comments, labels). The patch is returned to
  the CLI; applying it is the user's problem.
- Persistence of agent state beyond what Think and Workflows give us
  for free.
- Streaming exec output to a UI; the agent runs each `exec` to
  completion in one tool round.
- Full `@cloudflare/git-tools` family. Only `git_clone` is vendored.
