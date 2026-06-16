/**
 * Pure-function tests for src/project-instructions.ts. No live R2;
 * we hand-roll a minimal R2Bucket fake that exposes just `.get(key)`
 * since that's the only method the helper calls. The fake's shape
 * matches the runtime R2Bucket binding closely enough for the
 * helper's call site; we cast through `unknown` because the workers-
 * types `R2Bucket` declares many more methods than we need.
 */
import { describe, it, expect } from "vitest";
import { fetchProjectInstructions } from "../src/project-instructions.js";

interface FakeObject {
  body: string;
  /**
   * Override the reported byte size. Defaults to `body.length`,
   * which is fine for the ASCII test payloads below; size-cap tests
   * set this explicitly to exercise the oversized-rejection path
   * without having to allocate a real 16 KiB+ buffer.
   */
  size?: number;
  /**
   * When true, `text()` throws — exercises the "object exists but is
   * unreadable" branch.
   */
  throwOnText?: boolean;
}

function makeBucket(objects: Record<string, FakeObject>, opts: { throwOnGet?: boolean } = {}): R2Bucket {
  const fake = {
    async get(key: string): Promise<R2ObjectBody | null> {
      if (opts.throwOnGet) throw new Error("bucket exploded");
      const obj = objects[key];
      if (!obj) return null;
      const body = obj.body;
      const size = obj.size ?? new TextEncoder().encode(body).byteLength;
      // Build just enough of R2ObjectBody to satisfy the helper.
      // The unused methods stay un-typed; the helper never reaches
      // them so we don't bother implementing them.
      return {
        size,
        text: async () => {
          if (obj.throwOnText) throw new Error("read failed");
          return body;
        },
      } as unknown as R2ObjectBody;
    },
  };
  return fake as unknown as R2Bucket;
}

describe("fetchProjectInstructions", () => {
  it("returns null when AGENTS.md is missing", async () => {
    const result = await fetchProjectInstructions(makeBucket({}));
    expect(result).toBeNull();
  });

  it("returns null when the file is empty", async () => {
    const bucket = makeBucket({ "AGENTS.md": { body: "" } });
    expect(await fetchProjectInstructions(bucket)).toBeNull();
  });

  it("returns null when the file is only whitespace", async () => {
    const bucket = makeBucket({ "AGENTS.md": { body: "  \n\n  \t  \n" } });
    expect(await fetchProjectInstructions(bucket)).toBeNull();
  });

  it("returns the trimmed body when AGENTS.md is present", async () => {
    const body = "\n# Project rules\n\n- Be concise.\n";
    const bucket = makeBucket({ "AGENTS.md": { body } });
    const result = await fetchProjectInstructions(bucket);
    // Outer whitespace stripped, inner formatting preserved.
    expect(result).toBe("# Project rules\n\n- Be concise.");
  });

  it("drops oversized files (>16 KiB) without reading them", async () => {
    // Claim the file is 17 KiB without actually allocating that much:
    // the helper short-circuits on the `size` field before calling
    // `text()`. The body returned by `text()` would have succeeded;
    // its absence in the result confirms the size check ran first.
    const bucket = makeBucket({
      "AGENTS.md": { body: "would have succeeded", size: 17 * 1024 },
    });
    expect(await fetchProjectInstructions(bucket)).toBeNull();
  });

  it("allows files right up to the 16 KiB cap", async () => {
    const bucket = makeBucket({
      "AGENTS.md": { body: "ok", size: 16 * 1024 },
    });
    expect(await fetchProjectInstructions(bucket)).toBe("ok");
  });

  it("swallows bucket errors and returns null", async () => {
    // R2 reachability failures must not be able to wedge a turn.
    const bucket = makeBucket({}, { throwOnGet: true });
    expect(await fetchProjectInstructions(bucket)).toBeNull();
  });

  it("swallows text() read failures and returns null", async () => {
    const bucket = makeBucket({
      "AGENTS.md": { body: "ignored", throwOnText: true },
    });
    expect(await fetchProjectInstructions(bucket)).toBeNull();
  });

  it("only looks at the AGENTS.md key, not similarly-named ones", async () => {
    // Defensive: a future refactor could accidentally start reading
    // `agents.md`, `AGENTS.MD`, or some skill bundle's AGENTS.md.
    // Today we only want the top-level one.
    const bucket = makeBucket({
      "agents.md":            { body: "lowercase, ignore" },
      "skills/foo/AGENTS.md": { body: "nested, ignore" },
      "AGENTS.MD":            { body: "wrong case, ignore" },
    });
    expect(await fetchProjectInstructions(bucket)).toBeNull();
  });
});
