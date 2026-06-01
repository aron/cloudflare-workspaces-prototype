# Agent guidelines

## After every code change

Run both of these from the repo root before considering a change done:

```bash
npm run format        # biome format --write .
npx biome check .     # biome lint + formatter verification
```

`npm run format` is allowed to rewrite files. `biome check` must exit
zero before you commit. If `check` complains, fix the underlying issue
rather than silencing the rule.

## Tests

Run the package-level tests for whatever you touched. For the whole
workspace:

```bash
npm test
```

For a single package:

```bash
npm test --workspace @cloudflare/dofs
```

For a single test file inside a package:

```bash
npm test --workspace @cloudflare/dofs -- src/path/to/file.test.ts
```

## Commits

- One logical change per commit. Don't bundle unrelated edits.
- Write the commit message in the style of the existing log: short
  imperative subject, blank line, paragraph(s) of context. No emojis,
  no marketing voice.
- Don't commit `artifacts/`, `dist/`, or `node_modules/` — these are
  ignored already, but double-check `git status` before staging.

## Plan

`PLAN.md` at the repo root is the implementation roadmap for
`packages/dofs`. When you complete a task, update the relevant
status bullets in the package's README and check the task off the plan.
