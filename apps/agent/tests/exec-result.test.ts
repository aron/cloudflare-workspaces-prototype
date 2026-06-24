import { describe, expect, it } from "vitest";
import {
  buildExecToolError,
  buildExecToolOutput,
  detectExecCommandKind,
  normalizeExecStream,
  truncateExecStream,
} from "../src/exec-result.js";

describe("exec-result helpers", () => {
  it("adds structured backend metadata while preserving legacy top-level backend", () => {
    const out = buildExecToolOutput({
      command: "git status --short",
      cwd: "/workspace/repo",
      requestedBackend: undefined,
      resolvedBackend: "shell",
    }, {
      exitCode: 0,
      stdout: " M README.md\n",
      stderr: "",
    });

    expect(out.backend).toBe("shell");
    expect(out.metadata).toEqual({
      kind: "exec",
      backend: "shell",
      requestedBackend: null,
      cwd: "/workspace/repo",
      commandKind: "git",
    });
    expect(out.stdout).toBe(" M README.md\n");
    expect(out.stderr).toBe("");
    expect(out.stdoutEmpty).toBe(false);
    expect(out.stderrEmpty).toBe(true);
  });

  it("records explicitly requested container backend in metadata", () => {
    const out = buildExecToolOutput({
      command: "bun install",
      requestedBackend: "container",
      resolvedBackend: "container",
    }, { exitCode: 0 });

    expect(out.metadata.backend).toBe("container");
    expect(out.metadata.requestedBackend).toBe("container");
    expect(out.metadata.commandKind).toBe("shell");
    expect(out.stdout).toBe("");
    expect(out.stderr).toBe("");
    expect(out.stdoutEmpty).toBe(true);
    expect(out.stderrEmpty).toBe(true);
  });

  it("normalizes non-string stdout/stderr values instead of dropping them", () => {
    const bytes = new TextEncoder().encode("hello from bytes\n");
    expect(normalizeExecStream(bytes)).toBe("hello from bytes\n");
    expect(normalizeExecStream(["a", bytes, null, "b"])).toBe("ahello from bytes\nb");
  });

  it("truncates large streams with a clear marker", () => {
    expect(truncateExecStream("abcdef", 3)).toBe("abc\n\n[truncated, 3 more chars]");
  });

  it("adds the same metadata to error outputs", () => {
    const out = buildExecToolError({
      command: "artifact share repo",
      cwd: "/workspace",
      requestedBackend: "shell",
      resolvedBackend: "shell",
    }, new Error("boom"));

    expect(out.metadata).toMatchObject({ backend: "shell", requestedBackend: "shell", commandKind: "artifact" });
    expect(out.error.details).toBe("boom");
  });

  it("detects built-in command kinds", () => {
    expect(detectExecCommandKind(" git diff")).toBe("git");
    expect(detectExecCommandKind("assets publish out.png")).toBe("assets");
    expect(detectExecCommandKind("artifact create demo")).toBe("artifact");
    expect(detectExecCommandKind("echo hi")).toBe("shell");
  });
});
