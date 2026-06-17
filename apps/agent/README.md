# @app/agent

LLM-driven chat agent that owns one Slack-style conversation per
thread, with file tools and a shell that operate on a shared
DO-backed virtual filesystem.

This is a reference consumer of
[`@cloudflare/workspace`](https://github.com/cloudflare/workspace).
The published package owns the SQLite VFS, the FUSE mount, and the
capnweb sync. This app does only chat-shaped things: defining tools,
picking a model, streaming the response, and rendering the chat.

## Architecture

```
┌────────────────────────────────────┐
│  Browser  (React + AI SDK chat)    │
└────────────────────────────────────┘
                 │ WebSocket
                 ▼
┌────────────────────────────────────┐         ┌───────────────────────────┐
│  Agent DO  (one per thread)        │         │  Sandbox DO (1:1 w/ a     │
│    Think + tools                   │── RPC ──┤  warm pool slot)          │
│    ├── WorkspaceStub ──────────────┼────────►│    Workspace              │
│    │     (fs.* / shell.exec)       │         │      ├── SQLite VFS       │
│    └── R2: SKILLS                  │         │      ├── R2 mounts        │
└────────────────────────────────────┘         │      └── capnweb session ──► wsd container
                                               │            (FUSE mount    │
                                               │             at /workspace)│
                                               └───────────────────────────┘
```

Same-DO constraint of `CloudflareContainerBackend`: the Workspace
lives inside the Sandbox DO because `ctx.container` can't cross
isolates. The Agent DO holds only a `WorkspaceStub` — a thin RPC
target that proxies `fs.*` / `shell.exec` back into the Sandbox.

## Setup

```sh
cp .dev.vars.example .dev.vars
# edit .dev.vars with OPENAI_API_KEY (or leave empty to use Workers AI)
```

Behind a TLS-intercepting corporate proxy? Drop your root CA into
`ca/warp-ca.crt` (gitignored). See the root [README](../../README.md#behind-cloudflare-warp-or-a-corporate-tls-proxy).

### Skills bucket

The agent enumerates skills from an R2 bucket bound as `SKILLS`. Each
skill is a directory containing a `SKILL.md` (Agent-Skills front-matter
with `name` and `description`) plus any sibling files it references.

Discovery walks R2 directly — `discoverSkills()` lists the bucket on
the first `beforeTurn` of a cold DO and caches the result on the
instance. There's no Workspace mount step; the system prompt's
`<available_skills>` block is populated from the cached array.

Source-of-truth skills live in `apps/agent/skills/`. Sync them to R2
with:

```sh
wrangler r2 bucket create hackspace-skills          # one-time, per env
wrangler r2 bucket create hackspace-skills-test     # for the test suite
npm run skills:sync                                  # remote prod bucket
npm run skills:sync:local                            # local miniflare bucket
```

Add a new skill by creating `apps/agent/skills/<name>/SKILL.md` and
re-running `npm run skills:sync`. No redeploy required.

### Project instructions (`AGENTS.md`)

Optional. The agent's system prompt mirrors pi's shape and includes a
`<project_context>` block; if the SKILLS bucket has a top-level
`AGENTS.md` object, its body is inlined inside that block as
`<project_instructions path="AGENTS.md">...</project_instructions>` on
every turn. Use it for house style, persona, or operator-specific
rules you want the agent to see without loading a skill.

Drop the file at `apps/agent/skills/AGENTS.md` and run
`npm run skills:sync` (the sync script walks the whole `skills/` tree,
and the discoverer ignores anything that isn't `*/SKILL.md`, so it
won't be mistaken for a skill). Capped at 16 KiB; empty / missing /
oversized files render no block at all.

### Assets bucket (`assets publish`)

Optional. The shell backend registers a built-in `assets publish
<path> [<expiry>]` command that uploads a workspace file to R2 and
returns a presigned GET URL the model can hand to the user. Wired
only when R2 S3 credentials are present in the env; without them
the command still registers but reports "publishing is not
configured for this workspace."

One-time setup, per environment:

```sh
# 1. R2 bucket the binding points at. Name matches wrangler.jsonc's
#    `r2_buckets[].bucket_name` for the ASSETS binding.
wrangler r2 bucket create hackspace-assets

# 2. R2 S3 API credentials — the binding alone can't mint a presigned
#    URL; the assets client signs against R2's S3 endpoint with these.
#    Mint them at
#    https://dash.cloudflare.com/?to=/:account/r2/api-tokens
wrangler secret put R2_ACCESS_KEY_ID
wrangler secret put R2_SECRET_ACCESS_KEY

# 3. Either set CLOUDFLARE_ACCOUNT_ID (recommended; the endpoint URL
#    is derived) or set R2_ENDPOINT explicitly.
wrangler secret put CLOUDFLARE_ACCOUNT_ID
```

Local dev: copy the same keys into `.dev.vars` (see
`.dev.vars.example`). The agent rechecks the gate every isolate
restart, so adding the keys requires a `wrangler dev` reload (or
redeploy) to take effect.

## Run locally

```sh
npm run dev
```

## Deploy

```sh
npm run deploy
```

The `predeploy` step builds the frontend bundle. The Sandbox container
image is built by wrangler from `apps/agent/Dockerfile` on `npm run
deploy`; it pulls the `wsd` SEA binary out of
`ghcr.io/cloudflare/workspace-wsd-linux-x64:0.0.0-alpha.9` and layers
the project toolchain on top (Node 24, npm, esbuild, wrangler).

## Debug endpoints

When deployed, useful for inspecting state:

| Endpoint | Method | Returns |
|---|---|---|
| `/api/threads/<id>/messages` | GET | Raw chat history (system/user/assistant/tool/reasoning parts) |
| `/api/threads/<id>/vfs`      | GET | Workspace file tree with sizes |
| `/api/threads/<id>/tar`      | GET | Uncompressed POSIX ustar with metadata, messages, and the `/workspace` subtree — handy for bug reports |
| `/api/threads/<id>/reset`    | POST | Clear chat history and release the assigned Sandbox |
| `/debug/<sessionId>/exec`    | POST `{command, cwd?}` | Run a raw command in the container |
| `/debug/<sessionId>/env`     | GET | Container info (toolchain versions, uname, mounts) |
| `/debug/<sessionId>/logs`    | GET | The container server log |
| `/debug/<sessionId>/pool`    | GET | Warm pool snapshot |

> **Note:** `/debug/*` endpoints have no auth. For a public deployment,
> gate them behind a secret token or restrict to dev environments.

## Known gaps

- **Streaming exec.** `WorkspaceShellStub.exec` returns a fully-buffered
  `{ stdout, stderr, exitCode }` shape; the chat UI no longer shows
  live stdout/stderr from long-running commands. The underlying
  `WorkspaceShell.exec` does emit a `ReadableStream<WorkspaceExecEvent>`,
  but the stub can't carry that across the DO RPC boundary without a
  framed transport. Tracked upstream against
  `@cloudflare/workspace`.
- **Exec inflight recovery.** A DO eviction mid-exec leaves the tool
  part in `input-streaming`. The new workspace API has no
  `getProcess` / `streamProcessLogs` reattach, so we lean on
  `resolveOrphanToolCalls` in `beforeTurn` to mark the call cancelled
  on the next turn.
