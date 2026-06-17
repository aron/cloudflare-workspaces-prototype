# Plan: Subagents as a Tool for the Agent Thread

## Overview

Expose the existing `SubAgent` Durable Object as an agentic **tool** callable
from the top-level `Agent` turn loop. The model can plan work, fan it out to
one or more named child agents, wait for results, and synthesise them back into
the conversation — all without any UI change.

Each sub-agent gets:

- The **same workspace** as the parent, via the shared `WorkspaceStub` (already
  held on the parent Agent DO).
- The **same fs / exec tools** (`read`, `write`, `edit`, `ls`, `stat`, `mkdir`,
  `rm`, `find`, `grep`, `exec`) the parent uses.
- **No** further delegation capability (sub-agents do not get the
  `delegate`/`subagents` tool — the parent is the planner, children are workers).

The parent receives a final text result for each child turn; it can submit
additional messages to drive multi-turn children if needed.

---

## Architecture

```
Agent DO (parent)
│
├── Workspace (local to this DO)
│   └── fs / shell — all read/write/exec ops
│
├── getTools()
│   ├── read / write / edit / ls / stat / mkdir / rm / find / grep / exec
│   ├── webfetch / websearch
│   └── delegate   ← NEW
│         ├── spawn_subagent(name, task)   → runs one turn, returns result
│         ├── chat_subagent(name, message) → sends follow-up to existing child
│         └── await_subagent(name)         → polls for completion (long tasks)
│
└── SubAgent DO (child, 1…N)
    ├── WorkspaceStub ← passed from parent as constructor param
    │    └── same backing Workspace, same VFS, same shell
    ├── getTools()
    │    ├── read / write / edit / ls / stat / mkdir / rm / find / grep / exec
    │    └── webfetch / websearch   (no delegate — intentional)
    └── getSystemPrompt() — focused variant: "worker agent, do exactly X"
```

The `WorkspaceStub` is already serialisable across Workers RPC boundaries
(that is how the worker backend's shell isolate accesses it today via
`Agent.getWorkspace()`). Sub-agents call `env.Agent.get(parentId).getWorkspace()`
on construction — the same public RPC method that already exists.

---

## New pieces

### 1. `SubAgent` gets workspace access

**Current state.** `SubAgent extends Think<Env>` with an empty `getTools()`.
It has no workspace, no system prompt, and no tool set.

**Change.** Give it:

```ts
// In SubAgent constructor
async getWorkspace(): Promise<WorkspaceStub> {
  // The sub-agent's name encodes <parentName>/<childName>.
  // We parse the parent name out and reach back via RPC.
  const parentName = parseParentName(this.name);
  const parentStub = this.env.Agent.get(this.env.Agent.idFromName(parentName));
  return parentStub.getWorkspace();
}
```

`getTools()` on `SubAgent` mirrors `Agent.buildTools()` **minus** the
`delegate` tool. The `getWs` lambda calls `this.getWorkspace()` lazily, same
pattern as the parent.

`getSystemPrompt()` returns a tighter version of the parent prompt:
- Same identity + tool list.
- Adds: `"You are a worker agent. Complete the task assigned to you and stop.
  Do not ask for clarification. Emit a short summary at the end."`
- No skills block (skills are a parent-level capability).
- Same `cwd` / date footer.

`getModel()` is identical to the parent (reads `OPENAI_API_KEY` / Workers AI).

### 2. `delegate` tool on `Agent`

Three actions, one tool with a `action` discriminator (keeps the model's tool
call surface small):

```ts
tool({
  description: `
    Delegate work to a named sub-agent that shares this workspace.
    Sub-agents have the same read/write/exec tools as this agent.
    Use 'start' to kick off a task, 'message' to drive a running child
    further, and 'result' to fetch the last completed turn's output.

    Good patterns:
      - Plan work, start several children in parallel, gather results.
      - Hand a child a long-running build while you continue researching.
      - Ask the child for more detail on a specific file it just wrote.

    Each child runs one LLM turn per 'start'/'message' call. The tool
    returns synchronously after that turn completes (or times out at
    120 s). For fire-and-forget work use 'start' without waiting for
    the result in the same step.
  `,
  inputSchema: z.discriminatedUnion("action", [
    z.object({
      action:  z.literal("start"),
      name:    z.string().describe("Stable child name, e.g. 'worker-build' or 'researcher-1'. Must be unique per logical task."),
      task:    z.string().describe("Full task description for the child. Be explicit — the child has no conversation context beyond this message."),
      reset:   z.boolean().optional().describe("Clear the child's message history before starting. Default false."),
    }),
    z.object({
      action:  z.literal("message"),
      name:    z.string().describe("Name of an already-started child."),
      message: z.string().describe("Follow-up instruction for the child."),
    }),
    z.object({
      action:  z.literal("result"),
      name:    z.string().describe("Name of a child whose last turn you want the output of."),
    }),
  ]),
  execute: /* see §3 */,
})
```

### 3. `delegate` tool execute implementation

`start` and `message` actions:

```ts
// Parent encodes child DO name as "<parentName>/<childName>"
const childDoName = `${this.name}/${input.name}`;
const childStub   = await this.subAgent(SubAgent, childDoName);

if (input.action === "start" && input.reset) {
  await childStub.fetch(new Request("https://child/reset", { method: "POST" }));
}

// Drive one model turn on the child by posting a user message and
// waiting for the assistant response.
const result = await childStub.runTask(input.action === "start" ? input.task : input.message);
return { name: input.name, status: "done", output: result };
```

`result` action (fetch the cached output without running a new turn):

```ts
const childDoName = `${this.name}/${input.name}`;
const childStub   = await this.subAgent(SubAgent, childDoName);
const output = await childStub.lastOutput();
return { name: input.name, output };
```

### 4. New RPC methods on `SubAgent`

**`runTask(message: string): Promise<string>`**

1. Append `message` as a user message (`this.session.appendMessage`).
2. Drive a single Think turn (`await this.chat(message)`). Think's
   `chatRecovery = true` handles DO eviction during the turn.
3. Return the last assistant message's text content.

The Think base class already has the loop, tool execution, and persistence.
We just need a synchronous RPC entry point that fires one turn and returns
the final text. Think exposes `chat()` — we use that:

```ts
@callable()
async runTask(message: string): Promise<string> {
  const result = await this.chat(message);
  // result is a ChatResponseResult; extract the text parts.
  return extractText(result.message);
}
```

**`lastOutput(): Promise<string>`**

Returns the text of the last assistant message without driving a new turn.
Falls back to `""` if no assistant message exists yet.

```ts
@callable()
lastOutput(): string {
  const msgs = [...this.messages].reverse();
  for (const m of msgs) {
    if (m.role !== "assistant") continue;
    const text = m.parts
      .filter(p => p.type === "text")
      .map(p => (p as { text: string }).text)
      .join("");
    if (text) return text;
  }
  return "";
}
```

### 5. Timeout and error handling

`runTask` runs inside `runCancellable` (same helper the parent's `exec` uses)
with a 120 s wall-clock timeout. If it fires:

```ts
return { name, status: "timeout", output: "(task timed out — use 'result' later or 'message' to continue)" };
```

Children do not inherit the parent's turn abort signal — they run to
completion (or their own timeout). The parent's `Stop` button aborts the
`delegate` tool call's wait, but the child keeps running in the background;
a follow-up `result` action will surface whatever it finished.

---

## System-prompt changes

### Parent (`Agent.getSystemPrompt`)

Add one line to `TOOL_SNIPPETS`:

```ts
["delegate", "start, message, or poll a named sub-agent that shares this workspace"],
```

Add a guideline block:

```
Sub-agent guidelines:
- Use delegate/start to farm out a well-scoped, self-contained task.
- Give the child enough context in 'task' that it can act without asking
  back — the child has no conversation history beyond what you send.
- Child names should be stable and descriptive: 'builder-1', 'researcher-auth'.
- After start, call delegate/result in a later step if you don't need the
  answer immediately; this lets you make progress on other work.
- Sub-agents share the same workspace (/workspace). Coordinate file paths
  explicitly — children write to separate directories when working in parallel
  (e.g. /workspace/research/, /workspace/build/).
- Sub-agents cannot spawn further sub-agents. You are the planner.
```

### Child (`SubAgent.getSystemPrompt`)

```
You are a worker agent operating inside a shared workspace at /workspace.
You have been given a specific task by the orchestrating agent. Complete it
precisely using the tools available, then stop. Do not ask for clarification —
make your best judgement on ambiguities. End your response with a concise
summary of what you did and what changed.

Available tools: [same tool list as parent, minus delegate]
Guidelines: [same file-tool and exec guidelines as parent]
Current date: ...
Current working directory: /workspace
```

---

## DO naming and lifecycle

Sub-agent DO names follow the pattern `<parentDoName>/<childName>`:

- `thread-abc123/worker-build`
- `thread-abc123/researcher-1`

This namespacing means:

- A `DELETE /` on the parent Agent DO should also clean up all its children.
  The parent's `onRequest` already handles `DELETE /`; extend it to enumerate
  and delete child DOs by calling `this.subAgent(SubAgent, name).delete()` for
  each name stored in a small `Set<string>` on the parent.
- Children are not visible in the UI (they are not seeded into any Room).
- The existing `SubAgent` binding in `wrangler.jsonc` and migration `v3` cover
  this — no new DO class or migration is needed.

Track active child names in `ctx.storage` under a single key
(`subagent-names: Set<string>`) so the parent can iterate them for cleanup.

---

## Implementation sequence

### Step 1 — `SubAgent.runTask` + `SubAgent.lastOutput`

Add the two `@callable()` RPCs. No tool changes yet. Run the existing
`subagent.test.ts` suite to confirm nothing regressed. Add a unit test that
calls `runTask` on a fresh `SubAgent` and asserts a non-empty string result
(mocked tool set is fine for this level — the goal is to prove the Think loop
fires and returns).

### Step 2 — `SubAgent.getWorkspace` + workspace-backed tool set

Wire `getWorkspace()` (parent RPC call). Build `getTools()` mirroring the
parent's `buildTools()` minus `delegate`. Add `getSystemPrompt()` returning
the worker variant. Add a test that runs a child with a `read` tool call and
verifies the VFS path resolves (use the agent-suite vitest-pool-workers fixture
which has a live workspace binding).

### Step 3 — `delegate` tool on `Agent`

Add the tool to `buildTools()`. Update `TOOL_SNIPPETS` and the guidelines
block in `system-prompt.ts`. Add unit tests for:

- `delegate/start` with a fresh child.
- `delegate/message` as a follow-up.
- `delegate/result` fetching cached output.
- Timeout path (mock `runTask` to hang, assert the tool returns a timeout
  result within the deadline).

### Step 4 — child cleanup on parent DELETE

Extend `Agent.onRequest` DELETE handler to track and sweep child DOs.
Add a test that creates two children then calls `DELETE /` on the parent and
asserts the child DOs are empty.

### Step 5 — system-prompt integration test

Run the full agent-suite E2E smoke: instruct the model to write a short file
using a sub-agent and verify that the file appears in the VFS. This exercises
the full round-trip: parent plan → `delegate/start` → child VFS write → parent
`delegate/result` → parent reads the file back.

---

## Files touched

| File | Change |
|---|---|
| `apps/agent/src/agent.ts` | Add `delegate` tool to `buildTools()`; add child-name tracking + cleanup in `DELETE /` handler. |
| `apps/agent/src/agent.ts` (`SubAgent`) | Add `getWorkspace()`, `getTools()`, `getSystemPrompt()`, `getModel()`, `runTask()`, `lastOutput()`. |
| `apps/agent/src/system-prompt.ts` | Add `delegate` to `TOOL_SNIPPETS`; add sub-agent guideline block; export `buildWorkerSystemPrompt()` for `SubAgent`. |
| `apps/agent/tests/agent-suite/subagent.test.ts` | Extend with workspace + tool round-trip tests. |
| `apps/agent/tests/agent-suite/delegate-tool.test.ts` | New file — unit tests for all three `delegate` actions + timeout. |

No changes needed to `wrangler.jsonc`, `worker-configuration.d.ts`,
`packages/`, or the frontend. The `SubAgent` DO binding and migration already
exist.

---

## Design decisions & trade-offs

### Why synchronous `runTask` instead of async + polling?

Think's `chatRecovery = true` already handles DO eviction during the turn —
the child fiber survives a restart. The parent's 120 s timeout is generous for
the tasks we expect (file writes, short builds, search queries). Async polling
adds UI surface area and a new storage key (`lastOutput`) for no benefit in
the common case. If a task genuinely needs more than 120 s, the model can
`start` it, do other work, then `result` later — the child's turn is persisted
in its own message history.

### Why no streaming output from children?

The same limitation that applies to `exec` across the DO RPC boundary applies
here. The child's turn output arrives as a single blob once `runTask` returns.
This is acceptable: the parent's turn stream still shows tool-call progress
(the model calls `delegate/start`, the UI shows the call in-flight, the result
arrives when the child is done).

### Why no tool approval / confirmation in children?

Children are spawned by the model with an explicit, scoped task. They use the
same tools as the parent, which already operate on the shared workspace.
Adding a second approval layer for child tool calls would require a UI surface
that doesn't exist today. The risk surface is the same as the parent (the
workspace is sandboxed inside the container). A future iteration could add
`allowedTools` scoping per child if finer-grained control is needed.

### Why not share the parent's `_loop` / `LoopTracker`?

Each DO has its own `maxSteps` / reflection budget. A child that thrashes on
its own sub-task shouldn't penalise the parent's loop counter. The child gets
its own `LoopTracker` instance (or relies on Think's built-in `maxSteps` limit
of 20 for now — `SubAgent` can always opt into the full tracker if the worker
prompt proves insufficient).

### Child naming: encoded parent name vs. separate registry

Encoding the parent name in the child DO name (`<parent>/<child>`) means the
parent can reconstruct child stubs without a registry lookup. The trade-off is
that DO names become slightly longer and less opaque. Given that the agent-suite
already uses long random names (e.g. `agent-abc123xyz`) this is acceptable.
A flat registry in `ctx.storage` tracks active child names for cleanup
purposes — that's the only place we need a list.
