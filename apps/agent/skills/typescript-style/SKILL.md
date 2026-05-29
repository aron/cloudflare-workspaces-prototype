---
name: typescript-style
description: Project-wide TypeScript conventions. Use before writing or reviewing TypeScript code in this codebase to stay consistent with the existing style.
---

# TypeScript Style

These conventions apply across the agent worker, the shared package, and the frontend.

## Types

- No `any` unless absolutely necessary. When unavoidable, comment why.
- Use erasable TypeScript syntax (Node strip-only mode): no parameter properties, `enum`, `namespace`, `import =`, `export =`. Use explicit fields with constructor assignments.
- Top-level imports only — no `await import()` or `import("pkg").Type`.
- Prefer `interface` for object shapes the consumer might augment; `type` for unions and computed types.
- Wire types live in `@app/shared`. Don't redeclare them in the agent or the frontend.

## Imports

- Group: stdlib → external → first-party → relative.
- Use `.js` suffixes on relative imports (the project compiles ESM with that convention).
- Re-exports go in a barrel only when more than one consumer imports the symbol.

## Code shape

- Inline single-line helpers that have only one call site.
- Avoid premature abstraction. Three concrete cases first, then refactor.
- Single-purpose modules: if a file has two unrelated exports, split it.

## Comments

- Comments explain *why*, not *what*. The code says what.
- Keep them short — a sentence or two, no headings unless the file warrants them.
- For public APIs, a TSDoc block: one-line summary, blank line, details.
- Do not preserve commented-out code; delete it.

## Errors

- Return error tuples or typed result objects at boundaries (tools, RPC); throw inside pure logic.
- Don't catch and ignore — at minimum, log a one-liner with enough context to grep for.

## Async

- Top-level `await` is fine in modules.
- Don't leave floating promises. Either `await` or pass to `ctx.waitUntil` (in a Worker) / hand off to a queue.

## Testing

- Run with vitest. Tests live next to their target under `tests/` or as `*.test.ts` siblings.
- Prefer real implementations and fakes over mocks. Stand up a real DO via vitest-pool-workers when you can.
- One assertion per concept. Descriptive names that read like a spec.

## Dependencies

- Pass `--no-audit --no-fund` to every `npm install` / `npm ci` you run via `exec`. The audit step makes an extra registry round-trip whose findings the agent can't action, and the funding banner is multi-line noise that costs tokens on the way back. Together they routinely shave seconds off a cold install.
- For installs whose output you don't need to diagnose, add `--loglevel=error` (or `--silent`) so the resolver's per-package progress lines don't dominate the exec output buffer.
- Example: `npm install --no-audit --no-fund --loglevel=error <pkg>`.
