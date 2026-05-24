/**
 * Skill discovery against a Workspace mount.
 *
 * Skills are mounted from R2 at `/workspace/.agents/skills/<name>/SKILL.md`.
 * Each SKILL.md carries an Agent-Skills front-matter block with at least
 * a `description`. The optional `name` falls back to the parent directory
 * name. Skills with `disable-model-invocation: true` are excluded from
 * what we enumerate — they exist on disk so the agent could `read` them
 * but they don't go into the system prompt.
 *
 * Validation rules track the Agent Skills spec (lowercase a-z + digits +
 * hyphens, no leading/trailing/consecutive hyphens, length cap) and pi's
 * implementation. Invalid skills are dropped silently — production logs
 * would normally pick them up; we keep this side pure so the prompt is
 * always well-formed regardless of bucket contents.
 */
import { parseFrontmatter } from "./frontmatter.js";
import type { Skill } from "./system-prompt.js";

const SKILLS_ROOT     = "/workspace/.agents/skills";
const SKILL_FILE      = "SKILL.md";
const MAX_NAME_LENGTH = 64;
const MAX_DESC_LENGTH = 1024;
const NAME_PATTERN    = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Minimal Workspace surface we need. Keeps tests easy to wire. */
interface WorkspaceLike {
  listFilesUnder(prefix: string): Promise<string[]>;
  readFile(path: string): Promise<Uint8Array | null>;
}

export async function discoverSkills(ws: WorkspaceLike): Promise<Skill[]> {
  let paths: string[];
  try {
    paths = await ws.listFilesUnder(SKILLS_ROOT);
  } catch {
    return [];
  }

  const decoder = new TextDecoder();
  const skills: Skill[] = [];

  for (const path of paths) {
    if (!path.endsWith(`/${SKILL_FILE}`)) continue;

    // Expect /workspace/.agents/skills/<name>/SKILL.md — exactly one segment
    // between SKILLS_ROOT and SKILL.md. Anything deeper (or shallower) is
    // not a top-level skill and gets skipped.
    const rel = path.slice(SKILLS_ROOT.length + 1, -("/" + SKILL_FILE).length);
    if (!rel || rel.includes("/")) continue;

    let bytes: Uint8Array | null;
    try { bytes = await ws.readFile(path); }
    catch { continue; }
    if (!bytes) continue;

    const { frontmatter } = parseFrontmatter(decoder.decode(bytes));

    const description = typeof frontmatter.description === "string"
      ? frontmatter.description.trim() : "";
    if (!description || description.length > MAX_DESC_LENGTH) continue;

    const fmName = typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";
    const name   = fmName || rel;
    if (!isValidName(name)) continue;

    if (frontmatter["disable-model-invocation"] === true) continue;

    skills.push({ name, description, location: path });
  }

  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}

function isValidName(name: string): boolean {
  if (!name || name.length > MAX_NAME_LENGTH) return false;
  return NAME_PATTERN.test(name);
}
