import type { RuntimeId } from "../../shared/events";
import type { ComparisonFixture } from "../../shared/fixture";

export type RuntimeToolDescriptions = {
  read: string;
  write: string;
  edit: string;
  exec: string;
};

export function createRuntimeSystemPrompt(runtime: RuntimeId): string {
  return runtime === "workspace" ? workspaceSystemPrompt() : sandboxSystemPrompt();
}

export function createTaskPrompt(fixture: ComparisonFixture): string {
  return [
    `You are working in a small docs project at ${fixture.root}.`,
    "",
    "Task:",
    fixture.task,
    "",
    "Known project files:",
    ...fixture.files.map((file) => `- ${file.path}`),
    "",
    "Start by reading the feature brief, style guide, navigation file, and relevant existing docs from the list above.",
    "Write the docs changes before running validation. When you are done, summarize what changed and how you verified it.",
  ].join("\n");
}

export function createRuntimeToolDescriptions(runtime: RuntimeId): RuntimeToolDescriptions {
  if (runtime === "workspace") {
    return {
      read: "Read a UTF-8 text file with Workspace file tools. Use this when you need exact file contents.",
      write:
        "Create or overwrite a text file with Workspace file tools. Use this for new files or full-file rewrites.",
      edit: "Apply exact text replacements with Workspace file tools. Each oldText must match exactly one current region in the file.",
      exec: "Run a shell command through the Workspace environment. Use this for docs validation or preview after content changes. Set cwd to /workspace/repo for project commands.",
    };
  }

  return {
    read: "Read a UTF-8 text file from the Sandbox filesystem.",
    write:
      "Create or overwrite a text file in the Sandbox filesystem. Use this for new files or full-file rewrites.",
    edit: "Apply exact text replacements to a file in the Sandbox filesystem. Each oldText must match exactly one current region in the file.",
    exec: "Run a shell command inside the Sandbox container. Use this freely for project inspection, search, package scripts, tests, and other shell-native workflows. Set cwd to /workspace/repo for project commands.",
  };
}

function workspaceSystemPrompt(): string {
  return [
    "You are an expert coding agent working in a Cloudflare Workspace.",
    "",
    "Environment:",
    "- The project root is /workspace/repo.",
    "- Use whichever tool is fastest and most reliable for the job.",
    "- Use read, edit, and write for exact file access and precise changes.",
    "- Use exec for docs validation or preview after content changes are in place.",
    "- Set cwd to /workspace/repo for project commands.",
    "",
    "Workflow:",
    "1. Inspect the project files before editing.",
    "2. Use edit for targeted changes to existing files.",
    "3. Use write only for new files or complete rewrites.",
    "4. Keep changes minimal and focused on the task.",
    "5. Finish with a concise summary of the change and verification.",
  ].join("\n");
}

function sandboxSystemPrompt(): string {
  return [
    "You are an expert coding agent working inside a Cloudflare Sandbox.",
    "",
    "Environment:",
    "- The project root is /workspace/repo.",
    "- Files are available inside the sandbox filesystem.",
    "- Use whichever tool is fastest and most reliable for the job.",
    "- Use read, edit, and write for exact file access and precise changes.",
    "- Use exec freely for project inspection, search, package scripts, tests, and other shell-native workflows.",
    "- exec runs commands inside the sandbox container.",
    "- Set cwd to /workspace/repo for project commands.",
    "",
    "Workflow:",
    "1. Inspect the project files before editing.",
    "2. Use edit for targeted changes to existing files.",
    "3. Use write only for new files or complete rewrites.",
    "4. Keep changes minimal and focused on the task.",
    "5. Finish with a concise summary of the change and verification.",
  ].join("\n");
}
