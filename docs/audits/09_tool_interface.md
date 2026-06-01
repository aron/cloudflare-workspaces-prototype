# Audit: docs/09_tool_interface.md

## Scope

`docs/09_tool_interface.md` describes `@cloudflare/fs-tools`: a package that
is supposed to export AI SDK `Tool` objects (`createReadTool`,
`createWriteTool`, `createEditTool`, `createGrepTool`, `createExecTool`)
plus a `FileStore` abstraction (`WorkspaceFileStore`, `InMemoryFileStore`,
shared diff helpers) for use from `@cloudflare/agents` agents. The doc
opens with a banner that it has diverged from the implementation; this
audit pins down exactly how much.

## Methodology

Inspected (read-only) against tip of tree:

- Repo layout: `packages/` contains `workspace`, `workspace-fs`,
  `workspace-rpc`, `wsd`. No `fs-tools`, no `git-tools`, no `ai-chat`,
  no `agents` package.
- Cross-repo grep for tool-shaped surface area:
  - `grep -rln -E "createReadTool|createWriteTool|createEditTool|createGrepTool|createExecTool|FileStore|WorkspaceFileStore|fs-tools" packages/ examples/`
    → only matches inside `docs/` itself.
  - `grep -rln -E "\btool\(|inputSchema|fs-tools|git-tools|ai-chat|@cloudflare/agents" packages/ examples/`
    → no matches.
  - `grep "ai"` / `"@cloudflare/agents"` across all package manifests
    → no AI SDK or Agents SDK dependency anywhere in the workspace.
- Confirmed the underlying surfaces the doc would build on do exist:
  `WorkspaceFilesystem.grep` (`packages/workspace-fs/src/fs/filesystem.ts:76`,
  delegating to `fs/grep.ts` returning `WorkspaceGrepMatch[]`), and
  `WorkspaceShell.exec` (`packages/workspace/src/shell.ts:120-141`,
  returning `ExecHandle<E>` with `ExecResult = { exitCode, stdout, stderr,
  pushed, pulled }` at `shell.ts:43-54`).
- Cross-checked against the project-layout doc and the doc-00 README
  audit: `docs/10_project_layout.md:18-19,63-78` lists both
  `packages/fs-tools` and `packages/git-tools`; `docs/audits/00_README.md`
  finding 5 already flags "Out-of-the-box tools for `@cloudflare/agents`"
  as not implemented.

## Findings

| # | Claim (doc line) | Status | Evidence | Notes | Tag |
| - | --- | --- | --- | --- | --- |
| 1 | `@cloudflare/fs-tools` package exists and ships AI SDK tools (L11-15) | ❌ | No `packages/fs-tools/` directory. No package named `@cloudflare/fs-tools` anywhere in the workspace. | Whole package missing. | needs-decision |
| 2 | `createReadTool` (L21, L60, L74-98) — line-windowed read with `maxLines=2000`, `maxBytes=256KiB`, `{ path, offset?, limit? }` schema, `nextOffset` continuation | ❌ | No `createReadTool` symbol in any package. | – | doc-fix (after package decision) |
| 3 | `createWriteTool` (L22, L61, L100-122) — `maxBytes=2 MiB`, `{ path, content }` schema, preserves `mode`, suggests `edit` on cap breach | ❌ | No `createWriteTool` symbol. | – | doc-fix |
| 4 | `createEditTool` (L23, L62, L123-149) — fuzzy match against original, unified-diff preview, BOM/EOL normalization, `{ path, edits: [{oldText,newText}] }` | ❌ | No `createEditTool` symbol; no `applyEditsToNormalizedContent`, `generateDiffString`, `generateUnifiedPatch` helpers in any package. | Diff machinery would have to be written from scratch. | doc-fix |
| 5 | `createGrepTool` (L24, L63, L151-179) — wraps `Workspace.grep`, `maxHits=200`, `maxBytesPerLine=1KiB`, `{ pattern, path, regex?, ignoreCase?, glob? }` | ❌ | No `createGrepTool` symbol. Underlying `WorkspaceFilesystem.grep(pattern, path, GrepOptions)` exists (`workspace-fs/src/fs/filesystem.ts:76-78`) so the substrate is real; the doc-claimed `Workspace.grep` shortcut does not exist either (grep lives on `workspace.fs`, not directly on `workspace`). | Substrate exists; wrapper does not; the `workspace.grep` shorthand the example uses is itself wrong. | doc-fix |
| 6 | `createExecTool` (L25, L64, L181-212) — wraps `Workspace.shell.exec`, `{ command, cwd? }` schema, `allowedCommands`, `timeoutMs=60_000`, stdout/stderr cap (32 KiB), `{ exitCode, stdout, stderr, truncated }` result | ❌ | No `createExecTool` symbol. `WorkspaceShell.exec` exists and matches the underlying contract assumed by the doc (`shell.ts:120-141`, `ExecResult` at `shell.ts:43-54`), though the wrapper would need to add `truncated` and the timeout/allow-list logic itself. | – | doc-fix |
| 7 | `WorkspaceFileStore`, `InMemoryFileStore`, `FileStore`, `FileStat` types (L29-33, L214-236) | ❌ | No `FileStore` interface anywhere. `Workspace.fs.readFile` / `writeFile` / `stat` exist (`workspace-fs/src/fs/filesystem.ts:44-95`) so the adapter target is real, but the adapter and the in-memory variant don't. | – | doc-fix |
| 8 | Import path `@cloudflare/ai-chat` and base class `AIChatAgent` in the wiring example (L38, L49) | ❌ | No such package in the repo. The Agents SDK class is upstream `agents/ai-chat-agent#AIChatAgent`; even if we depended on it, the path would not be `@cloudflare/ai-chat`. | The wiring example uses a name we don't own. | doc-fix |
| 9 | Tools are "plain AI SDK `Tool` objects" passable to `generateText` / `streamText` (L70-72) | ❌ | No `ai` (Vercel AI SDK) dependency in any workspace package; nothing implements the `Tool` shape. | – | doc-fix |
| 10 | "Delegates to `Workspace.grep`" with link to 04 (L174-175) | ❌ | `grep` is on `workspace.fs.grep`, not `workspace.grep`. Doc 09 perpetuates a shorthand that doesn't exist on the actual class. | Even after a real package lands, this sentence needs to say `workspace.fs.grep`. | doc-fix |
| 11 | "Container-side ripgrep when sandbox available, DO-side scan otherwise" (L176-177) | ⚠️ | The current `fs/grep.ts` implementation lives DO-side (it operates on the SQLite-backed VFS); whether container-side ripgrep is wired is out of scope for this doc but the claim should be verified against doc 04 / `fs/grep.ts` before it makes it into a real `fs-tools` README. | Substrate claim, not a `fs-tools` claim per se. | doc-fix |
| 12 | Conventions section (L242-259): absolute paths, continuation offsets, edits-vs-original prompt, `truncated` flag for grep, `allowedCommands` posture for exec | ❌ (vacuously) | No tools exist for these conventions to apply to. The guidance is sensible if/when the package lands. | Preserve verbatim once tools ship. | doc-fix |

## Drift summary

This is the most extreme case in the audit set so far: **the entire
package described by this document does not exist.** Every normative
claim about a tool, store, helper, or import path is aspirational.

Concretely missing:

- `packages/fs-tools/` — not present.
- `packages/git-tools/` — not present (referenced from doc 10 but out of
  scope here).
- AI SDK dependency (`ai`) — not in any `package.json`.
- `@cloudflare/agents` / `@cloudflare/ai-chat` dependencies — not in
  any `package.json`.
- `FileStore` interface, `WorkspaceFileStore` adapter,
  `InMemoryFileStore`, diff helpers — none of these symbols exist.
- The `create*Tool` factories — none exist.

What *does* exist, and would be the foundation if/when the package
lands:

- `workspace.fs.readFile` (string + stream overloads),
  `workspace.fs.writeFile` (string/Uint8Array/ReadableStream),
  `workspace.fs.stat`, `workspace.fs.grep` — `filesystem.ts:44-95`.
- `workspace.shell.exec` returning a streaming `ExecHandle` with
  `result()` yielding `{ exitCode, stdout, stderr, pushed, pulled }` —
  `shell.ts:120-141`, `shell.ts:43-54`.

So the substrate the tools are supposed to wrap is in good shape; only
the wrappers and the AI-SDK glue are missing.

The doc itself already opens with a "diverged from implementation"
banner, which is honest but doesn't go far enough — a reader could
plausibly come away thinking some subset of these tools exists. The
banner should be sharpened to "package not yet implemented" once the
decision below is made.

## Recommendations

Default tag is `doc-fix`. The whole-package question is
`needs-decision`. There is no `code-fix` here because there is no
existing tool code to be wrong about.

- **needs-decision**: do we still want `@cloudflare/fs-tools` (and the
  sibling `@cloudflare/git-tools` referenced from doc 10) as a separate
  package, or has the project's centre of gravity moved? The current
  workspace ships `workspace`, `workspace-fs`, `workspace-rpc`, `wsd`
  and an `examples/wsd-container`. None of them consume AI SDK or
  `@cloudflare/agents`. Before re-syncing this doc, the project needs
  to decide:
  1. Are we still committing to ship AI SDK tools at all?
  2. If yes, is `@cloudflare/fs-tools` the right package home, or should
     the tools live as a subpath of `@cloudflare/workspace` (e.g.
     `@cloudflare/workspace/tools`) so consumers don't have to learn
     about a second package?
  3. Same question for `git-tools` — separate package, or fold into the
     same surface?
  4. Is the `FileStore` abstraction worth keeping as an indirection
     layer at all? The doc justifies it with "Custom stores let the
     same tools drive an SSH bridge, a remote git working tree, …"
     (L235-236) which is a real DX win, but it's also additional
     surface to maintain. If we expect 100% of consumers to use
     `WorkspaceFileStore`, dropping `FileStore` and binding the tools
     to `Workspace` directly is simpler.

- **doc-fix** (contingent on the above going "yes, keep the package"):
  - Strengthen the opening banner from "diverged" to "package not yet
    implemented; this is a design target." Same banner pattern as
    other forward-looking docs.
  - Fix `Workspace.grep` → `Workspace.fs.grep` in the `createGrepTool`
    section (L174). This is wrong even as a design target — grep lives
    on `fs` in today's API and there's no reason to promote it.
  - Replace `@cloudflare/ai-chat` in the wiring example (L38) with
    the real `@cloudflare/agents` / `agents/ai-chat-agent` import path,
    or drop the example until we know which base class consumers will
    actually extend.
  - Once tools land, tighten the `read` description: the current text
    says "Lazy through `store.readChunks(path)` — never materializes
    the full file unless the file itself fits in the budget" (L96-98).
    That's a real, testable property; make sure the implementation
    actually streams through `readChunks` rather than calling
    `readFile` and slicing, otherwise the doc claim becomes a lie.

- **doc-fix** (if the decision goes "no, drop the package"): delete
  this doc and the corresponding `packages/fs-tools` / `packages/git-tools`
  entries in `docs/10_project_layout.md`, and remove the "Out-of-the-box
  tools" bullet from `docs/README.md` (already flagged in audit 00).

## Drifts where the doc target still looks valuable

Even though the package doesn't exist, several pieces of the design are
worth preserving as targets if the `needs-decision` lands on "keep":

- **The `read` tool's `nextOffset` continuation protocol**
  (L95-98). Returning continuation offsets rather than expecting the
  model to ask for the whole file is the kind of small protocol detail
  that pays for itself many times over once an agent is in a tight
  loop. Worth keeping verbatim.
- **`edit` matching against the *original* file content with explicit
  rejection of overlapping edits** (L142-149). This is the right
  semantics — incremental edit application is exactly where
  hard-to-debug "model lost track of the file" bugs come from. Keep.
- **`grep` returning a `truncated` flag rather than paginating**
  (L177-179, L253-255). Refining the query is almost always what you
  want a model to do when grep hits its cap; pagination is a footgun.
  Keep.
- **`exec` `allowedCommands` allow-list and stdout/stderr byte cap with
  a `truncated` flag** (L190-191, L204-206, L256-259). Both are
  defensible defaults for an LLM-driven shell. Keep.
- **`FileStore` as a swappable adapter** (L29-31, L234-236) — only if
  the project actually intends to drive non-`Workspace` backends
  (SSH bridge, remote git working tree). Otherwise it's premature
  abstraction. This is part of the `needs-decision` above.

Everything else is straightforwardly "this is a design doc for an
unwritten package; either build it or retire the doc."
