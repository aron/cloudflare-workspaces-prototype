import { describe, expect, test } from "vitest";
import { comparisonFixture } from "../../shared/fixture";
import {
  createRuntimeSystemPrompt,
  createRuntimeToolDescriptions,
  createTaskPrompt,
} from "./prompts";

describe("runtime Think prompts", () => {
  test("gives Workspace practical guidance for direct file tools and process commands", () => {
    const prompt = createRuntimeSystemPrompt("workspace");

    expect(prompt).toContain("Cloudflare Workspace");
    expect(prompt).toContain("The project root is /workspace/repo.");
    expect(prompt).toContain("Use whichever tool is fastest and most reliable for the job.");
    expect(prompt).toContain(
      "Use read, edit, and write for exact file access and precise changes.",
    );
    expect(prompt).toContain("Use exec for package scripts, tests, and runtime verification.");
  });

  test("gives Sandbox practical guidance for a normal container workflow", () => {
    const prompt = createRuntimeSystemPrompt("sandbox");

    expect(prompt).toContain("Cloudflare Sandbox");
    expect(prompt).toContain("The project root is /workspace/repo.");
    expect(prompt).toContain("Use whichever tool is fastest and most reliable for the job.");
    expect(prompt).toContain(
      "Use exec freely for project inspection, search, package scripts, tests",
    );
    expect(prompt).toContain("exec runs commands inside the sandbox container");
  });

  test("builds the same task prompt for each runtime", () => {
    const prompt = createTaskPrompt(comparisonFixture);

    expect(prompt).toContain("You are working in a small TypeScript project at /workspace/repo.");
    expect(prompt).toContain(comparisonFixture.task);
    expect(prompt).toContain("Known project files:");
    expect(prompt).toContain("- package.json");
    expect(prompt).toContain("- src/request-policy.ts");
    expect(prompt).toContain("Start by reading the relevant files from the list above.");
    expect(prompt).toContain("summarize what changed and how you verified it");
  });

  test("tunes tool descriptions to the runtime boundary", () => {
    const workspace = createRuntimeToolDescriptions("workspace");
    const sandbox = createRuntimeToolDescriptions("sandbox");

    expect(workspace.read).toContain("Workspace file tools");
    expect(workspace.exec).toContain("package scripts, tests, and runtime verification");
    expect(sandbox.read).toContain("Sandbox filesystem");
    expect(sandbox.exec).toContain(
      "Use this freely for project inspection, search, package scripts, tests",
    );
  });
});
