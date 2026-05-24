/**
 * Skill discovery from a Workspace mount.
 *
 * In production the SKILLS R2 bucket is mounted at /workspace/.agents/skills
 * and the agent enumerates `<name>/SKILL.md` directories under it. We test
 * the discovery logic here against a fake mount that mirrors the same
 * directory shape, so the assertions stay focused on:
 *   - what counts as a discoverable skill
 *   - which validation failures drop a skill silently
 *   - the metadata shape passed to buildSystemPrompt's <available_skills>
 */
import { describe, expect, it } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { Workspace, type Mount, type MountEntry } from "@cloudflare/workspace";
import { discoverSkills } from "../../src/skills.js";
import type { MountHost } from "./mount-host.js";

const enc = new TextEncoder();

declare global {
  namespace Cloudflare {
    interface Env {
      MountHost: DurableObjectNamespace<MountHost>;
    }
  }
}

function stubFor(name: string) {
  return env.MountHost.get(env.MountHost.idFromName(name));
}

function fakeMount(files: Record<string, string>): Mount {
  return {
    kind: "fake",
    writable: false,
    async list(): Promise<MountEntry[]> {
      const entries: MountEntry[] = [];
      const dirs = new Set<string>();
      for (const [path, body] of Object.entries(files)) {
        entries.push({ relPath: path, type: "file", size: body.length, mtime: 1000 });
        const parts = path.split("/");
        for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
      }
      for (const d of dirs) entries.push({ relPath: d, type: "dir" });
      return entries;
    },
    async fetch(relPath) {
      const body = files[relPath];
      if (body === undefined) throw new Error(`fake mount: not found: ${relPath}`);
      return enc.encode(body);
    },
  };
}

function wsWithSkills(storage: DurableObjectStorage, mount: Mount): Workspace {
  return new Workspace({
    storage,
    sandbox:   {} as never,
    sessionId: "skills-host",
    mounts:    { "/workspace/.agents/skills": mount },
  });
}

const SKILL_OK = (name: string, desc: string) =>
  `---\nname: ${name}\ndescription: ${desc}\n---\n\n# ${name}\n\nbody.\n`;

describe("discoverSkills", () => {
  it("returns an empty list when the skills mount has no SKILL.md files", async () => {
    const mount = fakeMount({ "README.md": "no skills here" });
    const result = await runInDurableObject(stubFor("skills-empty"), async (_o: MountHost, state) => {
      const ws = wsWithSkills(state.storage, mount);
      return discoverSkills(ws);
    });
    expect(result).toEqual([]);
  });

  it("discovers one skill per <name>/SKILL.md", async () => {
    const mount = fakeMount({
      "cloudflare-workers/SKILL.md": SKILL_OK("cloudflare-workers", "Workers fundamentals."),
      "agents-sdk/SKILL.md":         SKILL_OK("agents-sdk",         "Cloudflare Agents SDK patterns."),
    });
    const skills = await runInDurableObject(stubFor("skills-two"), async (_o: MountHost, state) => {
      const ws = wsWithSkills(state.storage, mount);
      return discoverSkills(ws);
    });
    expect(skills).toHaveLength(2);
    const byName = Object.fromEntries(skills.map(s => [s.name, s]));
    expect(byName["cloudflare-workers"]).toMatchObject({
      name: "cloudflare-workers",
      description: "Workers fundamentals.",
      location: "/workspace/.agents/skills/cloudflare-workers/SKILL.md",
    });
    expect(byName["agents-sdk"]).toMatchObject({
      name: "agents-sdk",
      description: "Cloudflare Agents SDK patterns.",
      location: "/workspace/.agents/skills/agents-sdk/SKILL.md",
    });
  });

  it("returns skills sorted by name (stable enumeration in the prompt)", async () => {
    const mount = fakeMount({
      "zeta/SKILL.md":  SKILL_OK("zeta",  "Z."),
      "alpha/SKILL.md": SKILL_OK("alpha", "A."),
      "mu/SKILL.md":    SKILL_OK("mu",    "M."),
    });
    const skills = await runInDurableObject(stubFor("skills-sorted"), async (_o: MountHost, state) => {
      const ws = wsWithSkills(state.storage, mount);
      return discoverSkills(ws);
    });
    expect(skills.map(s => s.name)).toEqual(["alpha", "mu", "zeta"]);
  });

  it("falls back to the parent directory name when frontmatter omits name", async () => {
    const mount = fakeMount({
      "fallback-name/SKILL.md": "---\ndescription: D.\n---\nbody\n",
    });
    const skills = await runInDurableObject(stubFor("skills-fallback"), async (_o: MountHost, state) => {
      const ws = wsWithSkills(state.storage, mount);
      return discoverSkills(ws);
    });
    expect(skills).toHaveLength(1);
    expect(skills[0]?.name).toBe("fallback-name");
  });

  it("skips skills with no description (invalid per spec)", async () => {
    const mount = fakeMount({
      "no-desc/SKILL.md": "---\nname: no-desc\n---\nbody\n",
      "ok/SKILL.md":      SKILL_OK("ok", "Has a description."),
    });
    const skills = await runInDurableObject(stubFor("skills-no-desc"), async (_o: MountHost, state) => {
      const ws = wsWithSkills(state.storage, mount);
      return discoverSkills(ws);
    });
    expect(skills.map(s => s.name)).toEqual(["ok"]);
  });

  it("skips skills whose name violates the lowercase/hyphen rule", async () => {
    const mount = fakeMount({
      "ok/SKILL.md":      SKILL_OK("ok", "good"),
      "BAD/SKILL.md":     SKILL_OK("BAD", "bad name"),       // uppercase
      "under_score/SKILL.md": SKILL_OK("under_score", "bad"), // underscore
    });
    const skills = await runInDurableObject(stubFor("skills-bad-name"), async (_o: MountHost, state) => {
      const ws = wsWithSkills(state.storage, mount);
      return discoverSkills(ws);
    });
    expect(skills.map(s => s.name)).toEqual(["ok"]);
  });

  it("excludes skills with disable-model-invocation: true", async () => {
    const mount = fakeMount({
      "hidden/SKILL.md": "---\nname: hidden\ndescription: hidden one.\ndisable-model-invocation: true\n---\nbody",
      "visible/SKILL.md": SKILL_OK("visible", "Visible one."),
    });
    const skills = await runInDurableObject(stubFor("skills-disabled"), async (_o: MountHost, state) => {
      const ws = wsWithSkills(state.storage, mount);
      return discoverSkills(ws);
    });
    expect(skills.map(s => s.name)).toEqual(["visible"]);
  });

  it("ignores stray markdown files that are not named SKILL.md", async () => {
    const mount = fakeMount({
      "ok/SKILL.md":     SKILL_OK("ok", "Good."),
      "ok/notes.md":     "stray note, should not be a skill",
      "loose/README.md": "no SKILL.md, no skill",
    });
    const skills = await runInDurableObject(stubFor("skills-stray"), async (_o: MountHost, state) => {
      const ws = wsWithSkills(state.storage, mount);
      return discoverSkills(ws);
    });
    expect(skills.map(s => s.name)).toEqual(["ok"]);
  });

  it("returns empty list when the skills mount is absent", async () => {
    // Workspace constructed with no mounts at all → no skills.
    const skills = await runInDurableObject(stubFor("skills-no-mount"), async (_o: MountHost, state) => {
      const ws = new Workspace({
        storage:   state.storage,
        sandbox:   {} as never,
        sessionId: "no-mount",
      });
      return discoverSkills(ws);
    });
    expect(skills).toEqual([]);
  });
});
