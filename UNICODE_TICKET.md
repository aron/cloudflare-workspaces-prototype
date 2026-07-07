# Bug: `edit` tool reports success but silently does not apply the change

**Component:** pi coding agent — `edit` tool (exact text replacement)
**Severity:** High (silent data-integrity / correctness failure)
**Status:** Observed repeatedly in a real session; not yet reproduced in isolation

---

## Summary

During a multi-edit session on `apps/agent/src/agent.ts`, the `edit` tool
repeatedly returned:

```
Successfully replaced 1 block(s) in /workspace/apps/agent/src/agent.ts
```

…but the file was **not modified**. The change simply wasn't there afterward.
This happened often enough to block progress: several edits had to be
re-applied with a Python fallback script (`python3 - <<'PY' … open().replace() …`)
before they landed.

The failure is **silent**: the tool claims success, so nothing downstream
flags it. It was only caught by chance — a later `git status` showed the target
file as unmodified even though `tsc` still passed (the pre-edit code remained
valid), and `grep` for the newly-inserted symbols returned zero matches.

## Why this is dangerous

- **False success.** The tool's success message is load-bearing — an agent
  trusts it and moves on. When it lies, later steps build on a file that never
  changed, producing confusing cascades (imports referencing symbols that were
  "added" but aren't there, tests failing for reasons that don't match the
  diff, etc.).
- **Hard to detect.** If the pre-edit file still type-checks (common when the
  edit is additive), there's no error to surface the miss. Only an explicit
  `grep`/`git status`/re-read reveals it.

## Observed correlation

Every failure in the session shared these traits:

1. The `newText` (and sometimes the `oldText` anchor) contained **non-ASCII
   punctuation**: em-dashes (`—`, U+2014), box-drawing chars
   (`─`, U+2500) in section-header comments, bullets (`•`, U+2022),
   and arrows (`→`, U+2192).
2. The target was a **large file** (`agent.ts`, ~2000+ lines).
3. The edits were **large multi-line blocks** (inserting whole methods /
   tool definitions), not one-liners.
4. The session had **several concurrent `tmux` jobs** running `tsc --noEmit`
   and `vitest` against the same package (not writing source, but reading it).

Edits **without** those non-ASCII chars applied reliably in the same session
(e.g. the `schedule` tool's ASCII-only follow-ups landed first try).

## What I could NOT reproduce (important)

In a clean, isolated attempt I could **not** trigger the false success. All of
the following **applied correctly**:

- `/tmp/unicode-repro.ts` — em-dash in `newText`. ✅ applied
- `/tmp/unicode-repro2.ts` — `oldText` anchor on a `// ── … ──` box-drawing
  comment line, multi-line `newText`. ✅ applied
- `/tmp/unicode-repro3.ts` — large `newText` block with box-drawing + em-dash +
  bullets + arrow together. ✅ applied

So the trigger is **not** simply "the text contains unicode." It is
intermittent and appears to depend on additional factors (large file, large
block, possibly concurrent readers, or a specific
encoding/normalization/offset condition the matcher hits). This ticket
documents the real observations so the maintainer can instrument the actual
code path; the isolated repros passing is itself a useful clue (rules out the
naive "unicode always breaks it" hypothesis).

## Steps to reproduce (best-effort)

Reliable isolated repro is **not yet known**. To attempt it, recreate the
session conditions as closely as possible:

1. Open a large source file (2000+ lines) — e.g. a copy of
   `apps/agent/src/agent.ts`.
2. In the background, start several long-running readers of that file:
   ```bash
   tmux new-session -d -s a 'npx tsc --noEmit'
   tmux new-session -d -s b 'npx vitest run'
   ```
3. Issue a sequence of `edit` calls whose `oldText` anchors and `newText`
   bodies contain box-drawing section headers (`// ── X ──`), em-dashes, and
   bullets — inserting whole multi-line method/tool blocks near the middle and
   end of the file.
4. After **each** edit, verify independently rather than trusting the success
   message:
   ```bash
   git status --short <file>              # unexpectedly clean == miss
   grep -c "<a symbol from newText>" <file>   # 0 == miss
   ```

Expected: every "Successfully replaced" corresponds to a real change.
Observed: some report success with no change to the file.

## Hypotheses for the maintainer to check

- **Unicode normalization mismatch.** If the matcher normalizes one side
  (e.g. NFC/NFD) but writes/compares the other un-normalized, a match can
  "succeed" against a normalized view while the write no-ops or targets the
  wrong span. Box-drawing/em-dash/bullet are exactly the code points where
  NFC≠NFD or where width/normalization edge cases live.
- **Byte-offset vs. code-point-offset vs. UTF-16-unit indexing.** A replace
  computed in one unit and applied in another can select an empty/zero-length
  span for multi-byte chars, yielding a reported "success" that writes nothing.
- **Match found but write lost.** A success counter incremented before the
  write is confirmed/flushed (or a swallowed write error) would produce exactly
  this symptom.
- **Concurrency.** A concurrent read of the file mid-edit (from the tmux
  `tsc`/`vitest` jobs) racing the read-modify-write could clobber the write —
  though builds shouldn't write source, worth ruling out.

## Suggested fixes

1. **Verify-after-write:** after applying, re-read the file and confirm the
   `oldText` span is gone / `newText` is present; if not, report failure
   instead of success.
2. **Normalize both sides identically** (or refuse to normalize at all) before
   matching, and match/replace in a single consistent index space
   (code points).
3. **Fail loudly** when the post-write content is unchanged — never emit
   "Successfully replaced" without a confirmed content delta.

## Workaround (used this session)

Apply the change with a Python here-doc that does an explicit
`open().read()` → `str.replace()` (with an `assert oldText in src`) →
`open().write()`, then `grep` to confirm. This never silently no-ops:

```bash
python3 - <<'PY'
path = "src/agent.ts"
src = open(path, encoding="utf-8").read()
old = "…anchor…"
assert old in src, "anchor missing"
src = src.replace(old, "…replacement…", 1)
open(path, "w", encoding="utf-8").write(src)
print("applied:", "…marker…" in src)
PY
```

## Impact in this session

At least ~5 edits to `apps/agent/src/agent.ts` across the compaction,
scheduling, Cloudflare-MCP, and screenshot features reported success but did
not apply; each was recovered via the Python fallback. No incorrect code was
shipped (caught by `git status`/`grep`/test runs), but it cost significant
time and would be a latent correctness risk for any agent that trusts the
success message without re-verifying.
