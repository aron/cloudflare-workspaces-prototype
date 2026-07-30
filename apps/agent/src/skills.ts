/**
 * Skill discovery against an R2 bucket.
 *
 * Skills live in R2 under keys like `<name>/SKILL.md`. Each SKILL.md
 * carries an Agent-Skills front-matter block with at least a
 * `description`. The optional `name` falls back to the parent directory.
 * Skills with `disable-model-invocation: true` are excluded from what we
 * enumerate — they exist on disk so the agent could `read` them via the
 * file tools (once they're materialised into the workspace), but they
 * don't go into the system prompt.
 *
 * Validation rules track the Agent Skills spec (lowercase a-z + digits +
 * hyphens, no leading/trailing/consecutive hyphens, length cap) and pi's
 * implementation. Invalid skills are dropped silently — production logs
 * would normally pick them up; we keep this side pure so the prompt is
 * always well-formed regardless of bucket contents.
 *
 * Before the workspace-next port, skills were surfaced as a Workspace
 * mount under `/workspace/.agents/skills/`; the agent then walked the
 * mount with `listFilesUnder` + `readFile`. The new
 * `@cloudflare/computer` doesn't expose the old `R2Mount` API, so this
 * file now talks to the R2 binding directly. The `location` field on
 * each `Skill` keeps the VFS-style path for backward compatibility —
 * the system prompt embeds it verbatim and the model can read it once
 * the bucket has been materialised into the workspace (TODO).
 */
import { parseFrontmatter } from "./frontmatter.js";
import type { Skill } from "./system-prompt.js";

const SKILLS_ROOT     = "/workspace/.agents/skills";
const SKILL_FILE      = "SKILL.md";
const MAX_NAME_LENGTH = 64;
const MAX_DESC_LENGTH = 1024;
const NAME_PATTERN    = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export async function discoverSkills(bucket: R2Bucket): Promise<Skill[]> {
  const decoder = new TextDecoder();
  const skills: Skill[] = [];
  let cursor: string | undefined;

  // Walk every page of the bucket. Skill bundles are small and rare,
  // so a single page is the common case; the cursor loop is here for
  // correctness if the bucket grows past R2's per-call cap (1000).
  for (;;) {
    let listing: R2Objects;
    try {
      listing = await bucket.list(cursor ? { cursor } : {});
    } catch {
      return skills;
    }

    for (const obj of listing.objects) {
      const key = obj.key;
      if (!key.endsWith(`/${SKILL_FILE}`)) continue;

      // Expect `<name>/SKILL.md` — exactly one segment before SKILL.md.
      // Nested skills aren't a top-level skill; skip them.
      const rel = key.slice(0, -(`/${SKILL_FILE}`.length));
      if (!rel || rel.includes("/")) continue;

      let body: ArrayBuffer | null;
      try {
        const got = await bucket.get(key);
        body = got ? await got.arrayBuffer() : null;
      } catch {
        continue;
      }
      if (!body) continue;

      const { frontmatter } = parseFrontmatter(decoder.decode(body));

      const description = typeof frontmatter.description === "string"
        ? frontmatter.description.trim() : "";
      if (!description || description.length > MAX_DESC_LENGTH) continue;

      const fmName = typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";
      const name   = fmName || rel;
      if (!isValidName(name)) continue;

      if (frontmatter["disable-model-invocation"] === true) continue;

      skills.push({
        name,
        description,
        location: `${SKILLS_ROOT}/${rel}/${SKILL_FILE}`,
      });
    }

    if (!listing.truncated) break;
    cursor = listing.cursor;
  }

  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}

function isValidName(name: string): boolean {
  if (!name || name.length > MAX_NAME_LENGTH) return false;
  return NAME_PATTERN.test(name);
}
