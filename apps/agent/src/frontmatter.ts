/**
 * Tiny YAML-front-matter parser for skill files.
 *
 * Agent Skills (https://agentskills.io) ship as Markdown with a small
 * YAML preamble fenced by `---`. The spec only needs flat scalar keys
 * (`name`, `description`) and one optional boolean
 * (`disable-model-invocation`). That's all we parse — no nested
 * structures, no arrays, no anchors — so we don't pull in a YAML
 * library.
 *
 * If the front-matter block is malformed (no closing fence), we return
 * empty frontmatter and the original text as body. Callers treat
 * missing `description` as a validation error and skip the skill.
 */

export interface Frontmatter {
  name?: string;
  description?: string;
  "disable-model-invocation"?: boolean;
  [key: string]: string | boolean | undefined;
}

export interface ParsedFrontmatter {
  frontmatter: Frontmatter;
  /** Everything after the closing `---` fence. */
  body: string;
}

const FENCE = "---";

export function parseFrontmatter(input: string): ParsedFrontmatter {
  // Normalize CRLF so we can match line-by-line on \n.
  const normalized = input.replace(/\r\n/g, "\n");

  if (!normalized.startsWith(FENCE + "\n") && normalized !== FENCE + "\n") {
    return { frontmatter: {}, body: input };
  }

  const lines = normalized.split("\n");
  // Find the closing fence on its own line, starting after the opener.
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === FENCE) { close = i; break; }
  }
  if (close < 0) {
    // No closing fence — treat as no front-matter.
    return { frontmatter: {}, body: input };
  }

  const fm: Frontmatter = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    if (line.startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    if (!key) continue;

    // Strip matching surrounding quotes.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key === "disable-model-invocation") {
      fm[key] = value === "true";
    } else {
      fm[key] = value;
    }
  }

  // Skip a single optional blank line that conventionally follows the fence.
  const bodyStart = lines[close + 1] === "" ? close + 2 : close + 1;
  const body = lines.slice(bodyStart).join("\n");
  return { frontmatter: fm, body };
}
