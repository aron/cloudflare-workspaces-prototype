import { describe, expect, it } from "vitest";
import {
  execEnvironmentLabel,
  execErrorMessage,
  statusFor,
  type ExecSnapshot,
} from "../src/components/ExecToolView.js";

describe("ExecToolView helpers", () => {
  it("labels the backend the package's exec tool reports, over the requested one", () => {
    const output: ExecSnapshot = {
      command: "git status",
      cwd: "/workspace",
      backend: "shell",
      exitCode: 0,
      stdout: "",
      stderr: "",
    };

    expect(execEnvironmentLabel({ backend: "container" }, output)).toBe("shell");
  });

  it("falls back through legacy output metadata, input backend, then shell", () => {
    expect(execEnvironmentLabel(undefined, { metadata: { backend: "container", commandKind: "git" } }))
      .toBe("container · git");
    expect(execEnvironmentLabel({ backend: "container" }, null)).toBe("container");
    expect(execEnvironmentLabel(undefined, null)).toBe("shell");
  });

  it("reports final empty-output commands by exit status", () => {
    expect(statusFor({ exitCode: 0, stdout: "", stderr: "" })).toEqual({
      kind: "ok",
      label: "exit 0",
    });
    expect(statusFor({ exitCode: 2, stdout: "", stderr: "boom" })).toEqual({
      kind: "fail",
      label: "exit 2",
    });
  });

  it("treats a missing exit code as still running", () => {
    expect(statusFor(undefined)).toEqual({ kind: "running", label: "running…" });
    expect(statusFor({ stdout: "partial" })).toEqual({ kind: "running", label: "running…" });
  });

  it("accepts both error encodings", () => {
    // The package's exec tool returns a bare string.
    expect(execErrorMessage({ error: "backend unavailable" })).toBe("backend unavailable");
    expect(statusFor({ error: "backend unavailable" })).toEqual({
      kind: "fail",
      label: "backend unavailable",
    });
    // The agent's cancellation wrapper returns { details }.
    expect(execErrorMessage({ error: { details: "tool call cancelled by user" } }))
      .toBe("tool call cancelled by user");
    expect(execErrorMessage({})).toBeUndefined();
  });
});
