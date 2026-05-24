# @app/agent

LLM-driven chat agent that writes small CLI tools, compiles them to
WebAssembly inside a Cloudflare Sandbox container, and runs them in
isolated Cloudflare Dynamic Workers.

Today the container ships with the **Zig** toolchain. Rust, Go and
JavaScript runtimes are on the roadmap — add them to the Dockerfile to
extend the agent.

This is a reference consumer of [`@cloudflare/workspace`](../../packages/workspace).
The workspace primitive does all the heavy lifting (DO-side VFS, container
sync, WASM execution); this app does only chat-shaped things: defining
tools, picking a model, streaming the response, and rendering the chat.

## Architecture

```
┌────────────────────────────────────┐
│  Browser  (React + AI SDK chat)    │
└────────────────────────────────────┘
                 │ WebSocket
                 ▼
┌────────────────────────────────────┐
│  Agent (Durable Object)            │
│    AIChatAgent + tools             │
│    └── Workspace                   │
│          ├── DoVfs (SQLite)        │
│          ├── capnweb client ───────┼──► Sandbox container
│          └── Worker Loader ────────┼──► Dynamic Worker (WASI)
└────────────────────────────────────┘
```

## Setup

```sh
cp .dev.vars.example .dev.vars
# edit .dev.vars with OPENAI_API_KEY (or leave empty to use Workers AI)
```

Behind a TLS-intercepting corporate proxy? Drop your root CA into
`sandbox/your-ca.crt` — see [`sandbox/README.md`](./sandbox/README.md).

### Skills bucket

The agent enumerates skills from an R2 bucket bound as `SKILLS` and
mounts them at `/workspace/.agents/skills/`. Each skill is a directory
containing a `SKILL.md` (Agent-Skills front-matter with `name` and
`description`) plus any sibling files it references.

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

## Run locally

```sh
npm run dev
```

## Deploy

```sh
npm run deploy
```

The `predeploy` script builds `@cloudflare/workspace`'s `dist/` (so the
container Dockerfile can `COPY` the pre-built server) and the UI bundle.

## Debug endpoints

When deployed, useful for inspecting state:

| Endpoint | Method | Returns |
|---|---|---|
| `/debug/<sessionId>/messages` | GET | Raw chat history (system/user/assistant/tool/reasoning parts) |
| `/debug/<sessionId>/vfs`      | GET | Workspace file tree with sizes |
| `/debug/<sessionId>/reset`    | POST | Clear chat history (keeps VFS) |
| `/debug/<sessionId>/exec`     | POST `{command, cwd?}` | Run a raw command in the container |
| `/debug/<sessionId>/env`      | GET | Container info (toolchain versions, uname, mounts) |
| `/debug/<sessionId>/logs`     | GET | The container server log |

> **Note:** `/debug/*` endpoints have no auth. For a public deployment,
> gate them behind a secret token or restrict to dev environments.
