---
name: triage
description: How the TriageAgent should approach a GitHub issue. Load this before deciding whether to attempt a fix or to write up findings.
---

# Triage skill

This skill captures the playbook the TriageAgent should follow when
handed a GitHub issue. It is mounted into the workspace from an R2
bucket at `/workspace/.agents/skills/triage/SKILL.md`; the agent can
read it like any other file.

## Workflow

1. **Clone the repository** into `/workspace/repo` with `git_clone`.
   Always shallow (`depth: 1`) unless the issue specifically asks
   about history.
2. **Read enough to understand the bug.** Use `read` and `ls` rather
   than `exec cat` / `exec ls`. Skim the README and any file paths
   the issue mentions before going wider.
3. **Decide the bet.** Either:
   - **Small, well-scoped:** apply the minimal fix with `write` /
     `edit`, then run the project's own tests / typecheck / build via
     `exec` to confirm. Stop as soon as the verification passes.
   - **Anything else:** do not edit. Write up the findings — what the
     bug is, the files most likely involved, the concrete next steps
     a human should take.
4. **Report progress** with `report_update` once or twice. Keep
   messages terse (one or two sentences). Do not say "DONE"
   yourself; the workflow emits the terminal message.

## Output contract

When the turn is finished, reply with a short natural-language
summary covering:

- whether you attempted a fix (yes/no) and why
- a one-line imperative commit subject (e.g. `fix: …`, `docs: …`,
  `investigate: …`)
- one or two paragraphs of context (commit body or findings)
- the absolute paths of any files you edited (may be empty)
- the verification commands you ran, in order (may be empty)
- concrete next steps a human should take (may be empty if the fix
  is complete)

The workflow computes the unified diff itself via `git diff HEAD`;
do not include it.

## Tool preference

Reach for the dedicated tools before `exec`. They are faster, give
structured output, and don't depend on which binaries happen to live
in the container:

| Need | Use |
| --- | --- |
| Clone a repo | `git_clone` |
| Read a file | `read` |
| List a directory | `ls` |
| Modify a file | `write` or `edit` |
| Run project tests / typecheck / build | `exec` |
| Update the user | `report_update` |

`exec` is the escape hatch — use it only for things the dedicated
tools can't express.
