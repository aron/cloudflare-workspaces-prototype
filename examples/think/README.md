# `@cloudflare/think` triage example

A small end-to-end example that uses [`@cloudflare/think`][think] and
[`agents/workflows`][workflows] to triage a GitHub issue. The agent
runs inside a [Cloudflare Container][containers] holding a
[`@cloudflare/workspace`][workspace] VFS; the workflow drives it
through three model steps (triage → fix → notify) and POSTs a final
unified diff back to the user.

[think]: https://www.npmjs.com/package/@cloudflare/think
[workflows]: https://developers.cloudflare.com/workflows/
[containers]: https://developers.cloudflare.com/durable-objects/containers/
[workspace]: ../../packages/workspace

## Shape

```
client (./triage)                worker                                   container
   │  POST /issue                   │                                         │
   ├──────────────────────────────▶ │  setContext + runWorkflow               │
   │                                ├──── TRIAGE_WORKFLOW ────────────────▶   │
   │                                │     fetch-issue → set-phase:triage      │
   │                                │     → step.prompt(triage) ─ tools ──▶ wsd
   │  POST /webhook (progress)      │                                         │
   │  ◀───────────────────────────  │                                         │
   │                                │     → set-phase:fix → step.prompt(fix) ─┤
   │                                │     → build-patch (git diff HEAD)       │
   │  POST /webhook (DONE + patch)  │     → notify-done                       │
   │  ◀───────────────────────────  │                                         │
```

The worker exposes one route, `POST /issue`, with body
`{ issue_url, webhook_url }`. It derives a stable DO name from the
issue, binds the webhook into the agent, and starts the workflow. The
CLI runs that webhook server on `0.0.0.0` so a containerised worker can
reach it back over the host network.

## Tools

The agent has different toolsets per phase. The workflow flips phases
via `agent.setPhase("triage" | "fix")` inside a `step.do` before each
`step.prompt`, so a replay after a crash still ends up in the right
phase.

| Tool            | Triage | Fix | Source                                  |
| --------------- | :----: | :-: | --------------------------------------- |
| `git_clone`     |   ✓    |  ✓  | `src/tools/git/clone.ts` (isomorphic-git) |
| `read`          |   ✓    |  ✓  | vendored from `hackspace/fs-tools`      |
| `ls`            |   ✓    |  ✓  | `src/agent.ts`                          |
| `report_update` |   ✓    |  ✓  | `src/tools/report-update.ts`            |
| `write`         |        |  ✓  | vendored from `hackspace/fs-tools`      |
| `edit`          |        |  ✓  | vendored from `hackspace/fs-tools`      |
| `exec`          |        |  ✓  | `src/tools/exec.ts`                     |

`git_clone` writes to the workspace through a small `WorkspaceGitFs`
adapter that enforces a byte budget (100 MiB by default) so a clone of
a huge repo can't OOM the worker. The clone uses isomorphic-git
directly against `https://github.com/<repo>` — no Cloudflare Artifacts
binding required.

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
