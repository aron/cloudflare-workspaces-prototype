/**
 * Decide how the user's editor input should be dispatched.
 *
 * `!/<absolute-path>` is the trigger for the inline file viewer. The
 * slash is required — it doubles as the start of the absolute VFS path,
 * which sidesteps any ambiguity about a current working directory.
 *
 * Anything else (including a lone `!` with no slash, or text that
 * happens to contain `!`) flows through to the normal chat send path.
 *
 * Pure function — no I/O, no globals. Tested in tests/bang-parser.test.ts.
 */

export type BangInput =
  | { kind: "bang"; path: string }
  | { kind: "chat" }
  | { kind: "invalid"; reason: string };

const TRIGGER = "!/";

export function parseBangInput(raw: string): BangInput {
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith(TRIGGER)) return { kind: "chat" };

  // Strip the leading `!`; keep the slash as part of the absolute path.
  const path = trimmed.slice(1).trimEnd();
  if (path === "/" || path.trim() === "/" || path.replace(/^\//, "").trim() === "") {
    return { kind: "invalid", reason: "empty path" };
  }
  if (path.split("/").some((seg) => seg === "..")) {
    return { kind: "invalid", reason: "parent segment" };
  }
  return { kind: "bang", path };
}
