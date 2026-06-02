# Think example — plan

A small, end-to-end example that uses `@cloudflare/think@^0.8` and
`agents@^0.14` Workflows to triage a GitHub issue. Lives under
`examples/think/` next to `examples/wsd-container/`.

## Scope

A user runs `./triage <issue_url>` on their laptop. The CLI starts a
local webhook server, POSTs to the worker, and prints progress
messages as they arrive. The worker boots a Cloudflare Container
running `wsd`, attaches a `@cloudflare/workspace` Workspace, and lets a
Think agent clone the repo, read files, run shell commands, and post
updates. The workflow sends a final message ending in `DONE` once the
agent returns its structured verdict.

This is a teaching example: public GitHub only, no auth, no retries
beyond what Think + Workflows give us for free.

## Pieces

### `examples/think/src/index.ts` — Worker

- `POST /issue` body `{ issue_url, webhook_url }`.
- Derive a stable agent name from the issue URL.
- Get the `TriageAgent` DO stub by name, call `setContext()` to bind
  the webhook URL, then call `startTriage({ issueUrl })`.
- Return `{ workflowId, agentName }`.

Single route, single handler. No router needed.

### `examples/think/src/agent.ts` — `TriageAgent extends Think`

- Owns a `@cloudflare/workspace.Workspace` backed by a Cloudflare
  Container running `wsd` — same wiring as `examples/wsd-container`
  (its own `CloudflareContainerBackend` + `WorkspaceProxy` egress).
- `getModel()` — Workers AI, hard-coded to
  `@cf/google/gemma-4-26b-a4b-it`. OpenAI fallback removed; this is a
  Workers-AI example.
- `getSystemPrompt()` — short and prescriptive. Includes the current
  phase (`triage` or `fix`) so the model knows which tools to expect
  and which behaviour to follow. The triage prompt says "look only,
  do not edit"; the fix prompt says "edit and verify with `exec`".
- `getTools()` — builds the vendored toolset closed over the workspace
  and webhook URL, then filters by the current phase. Triage phase:
  `git_clone`, `read`, `ls`, `report_update`. Fix phase: triage
  tools plus `write`, `edit`, `exec`.
- RPC surface: `setContext`, `setPhase("triage" | "fix")`,
  `startTriage`, `postWebhook`, `gitDiff()` (execs `git -C /workspace/repo
  diff HEAD` and returns the patch text).

### `examples/think/src/workflow.ts` — `TriageWorkflow extends ThinkWorkflow`

Three model steps, plus the terminal notify. The agent narrows its
toolset per step by calling `agent.setPhase(...)` inside `step.do`
just before each `step.prompt` — read-only for triage, write+exec
for fix.

- `step.do("fetch-issue")` — fetch the issue body via the public
  GitHub REST API (no auth).
- `step.do("phase:triage")` → `step.prompt("triage", { output:
  triageSchema })` — read-only tools only: `git_clone`, `read`,
  `ls`, `report_update`. The model summarises the bug and points at
  suspect files. No `write`, `edit`, or `exec` here.
- `step.do("phase:fix")` → `step.prompt("fix", { output:
  fixSchema })` — full toolset: read-only + `write`, `edit`, `exec`.
  The model edits files and uses `exec` to run the project's tests /
  typecheck / build to confirm the fix. Output is a structured
  patch plan (see below).
- `step.do("build-patch")` — generate a unified diff from the
  workspace by execing `git diff HEAD` inside the container, and
  combine it with the model's commit message.
- `step.do("notify-done")` — POST `{ message, patch, commit }` to
  the webhook where `message` ends in `DONE`.

Schemas:

- `triageSchema`: `{ summary: string, suspectedAreas: string[],
  suggestedNextStep: string }`.
- `fixSchema`: `{ commitSubject: string, commitBody: string,
  filesChanged: string[], testsRun: string[] }`.

The triage output is fed into the fix prompt so the fix step has
context without re-reading. If `filesChanged` comes back empty the
workflow still notifies — sometimes the right answer is "can't
reproduce, here is what I checked".

### `examples/think/src/tools/` — vendored from `hackspace`

The `@cloudflare/fs-tools` and `@cloudflare/git-tools` packages aren't
published yet. Vendor the minimum we need from the `hackspace` branch,
keeping the file layout so future un-vendoring is mechanical:

- `tools/fs/edit-diff.ts`, `tools/fs/stores/types.ts`,
  `tools/fs/stores/workspace.ts`, `tools/fs/tools/{read,write,edit}.ts`
  — verbatim from `packages/fs-tools/src/`.
- `tools/git/clone.ts` — new. Uses `isomorphic-git` directly against
  GitHub over its `http/web` adapter, writing into a `WorkspaceFs`
  adapter (below) that targets `@cloudflare/workspace`'s filesystem
  surface. No Artifacts binding, no `ForkRegistry`, no fork. Shallow
  depth-1 by default with a 100 MiB byte budget enforced inside the
  fs adapter — same safeguards the hackspace tool documents.
- `tools/git/workspace-fs.ts` — new. The Node-fs-shaped adapter
  isomorphic-git expects (`promises.{readFile,writeFile,readdir,
  mkdir,stat,lstat,unlink,rmdir,readlink,symlink}`) implemented over
  `workspace.fs`. This is the only piece of glue between the
  workspace and isomorphic-git, kept small so it's obvious.
- `tools/exec.ts` — new, but borrowed from the streaming exec tool
  in `apps/agent/src/agent.ts`. Wraps `workspace.exec(command,
  { cwd })` and returns `{stdout, stderr, exitCode}`. We drop the
  AsyncIterable streaming + `LoopTracker` + per-call cancellation:
  this example doesn't have a UI to stream into.
- `tools/report-update.ts` — new. POSTs `{ message }` to the bound
  webhook. Failures returned, not thrown. System prompt forbids the
  model from including the word `DONE` here — the workflow owns the
  terminal message.

No Artifacts binding. `git_clone` runs isomorphic-git inside the
Worker isolate, writing to the container-backed workspace filesystem
over the existing capnweb session. Trade-off: the packfile has to
fit in workerd's heap. Fine for typical repos at depth 1, which is
what the demo asks for.

### `cli/triage.mjs` — CLI

Plain Node, no deps:

1. Parse `argv[2]` as the issue URL.
2. `http.createServer` listening on `0.0.0.0:0` so a worker running
   inside Docker / a sandbox container can reach the host's webhook.
   Print the resolved URL on startup so it's obvious which interface
   the model will hit.
3. Webhook handler accepts `POST /webhook` with two shapes:
   - `{ message }` — a progress update; print verbatim. If the
     message ends in `DONE`, mark the run as finished.
   - `{ message, patch, commit }` — the terminal payload from
     `notify-done`. Print the message, then the commit subject /
     body, then the unified diff (lightly coloured with ANSI: `+`
     green, `-` red, hunk headers cyan). Exit 0 after printing.
4. Resolve the webhook URL as `http://${HOST}:${port}/webhook`. Default
   host is the first non-loopback IPv4 from `os.networkInterfaces()`;
   override via `--host` / `TRIAGE_HOST`. Default worker URL is
   `http://127.0.0.1:8787`; override via `--worker` / `TRIAGE_WORKER`.
5. POST `{ issue_url, webhook_url }` to `<worker>/issue`.

10-minute hard timeout so a silent worker death doesn't leave the CLI
hanging.

## Config

`wrangler.jsonc`:

- `ai` binding for Workers AI.
- `containers` entry building from `./Dockerfile` (mirrors
  `examples/wsd-container/`), exposing the `TriageAgent` class as the
  container-enabled DO.
- No `artifacts` binding — `git_clone` uses isomorphic-git directly.
- `WorkspaceProxy` re-exported for container egress.
- One workflow binding `TRIAGE_WORKFLOW` → `TriageWorkflow`.
- `migrations.v1`: `new_sqlite_classes: ["TriageAgent"]`.
- `nodejs_compat` flag (isomorphic-git uses `buffer`).

`Dockerfile`: same as `examples/wsd-container/Dockerfile`. Stages the
`wsd` binary built by the workspace `build:wsd` script. Add a
`predev` / `predeploy` hook in `package.json` to build it.

`package.json` runtime deps: `@cloudflare/think@^0.8`, `agents@^0.14`,
`ai@^6`, `@cloudflare/workspace` (workspace local), `isomorphic-git@^1.38`,
`workers-ai-provider@^3`, `zod@^4`. Dev: `wrangler`,
`@cloudflare/workers-types`, `typescript`. `bin.triage` points at
`./cli/triage.mjs`.

## Out of scope

- Private repos / GitHub auth.
- Pagination of large repos.
- Writing back to the issue (comments, labels). We POST a webhook and
  stop. If we wanted GitHub write access this is where it would go,
  in a follow-up `step.do("post-comment")`.
- Persistence of agent state beyond what Think gives us for free.
- The streaming exec UI machinery from hackspace (`LoopTracker`,
  `ExecOutputBuffer`, per-tool-call cancellation). This example has
  no UI to stream into.
- The full `git-tools` family. Only `git_clone` is vendored.
- Tests. The example is small enough to verify by running it.

## Build order

1. Skeleton: `package.json`, `wrangler.jsonc`, `tsconfig.json`,
   `Dockerfile`, `README.md`. Verify `npm install` resolves.
2. Vendor `tools/fs/*` from hackspace; verify it typechecks against
   the `next`-branch `@cloudflare/workspace`. Touch imports only
   where the branch APIs diverge.
3. Write `tools/git/workspace-fs.ts` and `tools/git/clone.ts`
   (isomorphic-git over the workspace).
4. Write `tools/exec.ts` and `tools/report-update.ts`.
5. `src/agent.ts` — container-backed Workspace, model, system prompt,
   phase-aware `getTools()`, `setPhase` / `gitDiff` RPCs.
6. `src/workflow.ts` and `src/index.ts` — triage → fix → build-patch
   → notify-done. Confirm `wrangler types` and `tsc --noEmit` are
   clean.
7. `cli/triage.mjs` + README. ANSI-colour the diff. Manual run
   end-to-end against `wrangler dev`.
