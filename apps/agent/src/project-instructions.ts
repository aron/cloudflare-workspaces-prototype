/**
 * Project-instructions fetch against the SKILLS R2 bucket.
 *
 * The hackspace's analogue of pi's `AGENTS.md`. Pi inlines that file
 * into a `<project_context>` block on every turn; the model reads it
 * before any of the project-shaped operational notes. We follow the
 * same pattern, but the file lives in R2 rather than on disk so the
 * deployment can swap it without a redeploy.
 *
 *   Key:   `AGENTS.md` (top-level in the SKILLS bucket).
 *   Body:  plain markdown / text. No front-matter is parsed; the
 *          whole body lands in the system prompt verbatim.
 *   Cap:   16 KiB (16 * 1024 bytes). Anything larger is dropped so
 *          a runaway file doesn't eat the model's input budget. Pi's
 *          AGENTS.md sits well under this in practice (~2 KiB).
 *
 * Missing / empty / oversized files all resolve to `null`. The
 * Agent DO treats `null` as "no project instructions" and renders
 * the system prompt without the block.
 *
 * Shipped alongside `discoverSkills`; both fetch from the same R2
 * binding. The skills sync script (`scripts/sync-skills.mjs`) walks
 * `apps/agent/skills/` recursively, so dropping an AGENTS.md at the
 * root of that tree uploads it to `<bucket>/AGENTS.md` automatically.
 */

const AGENTS_KEY = "AGENTS.md";
const MAX_BYTES = 16 * 1024;

/**
 * Fetch the project-instructions document from R2. Returns `null`
 * when the object is missing, empty, oversized, or unreadable; the
 * caller treats `null` as "no instructions" and skips the prompt
 * block entirely.
 *
 * Errors are swallowed deliberately. Like skills discovery, this
 * runs as part of the cold-turn warmup and must not be able to
 * wedge a chat session — a missing AGENTS.md is the common case,
 * not an exception.
 */
export async function fetchProjectInstructions(bucket: R2Bucket): Promise<string | null> {
  let got: R2ObjectBody | null;
  try {
    got = await bucket.get(AGENTS_KEY);
  } catch {
    return null;
  }
  if (!got) return null;
  // R2's `size` is authoritative — drop oversized objects before we
  // pay the bandwidth to read them. The 16 KiB cap is policy, not a
  // hard limit; if a project genuinely needs more we'll revisit.
  if (typeof got.size === "number" && got.size > MAX_BYTES) return null;
  let text: string;
  try {
    text = await got.text();
  } catch {
    return null;
  }
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  return trimmed;
}
