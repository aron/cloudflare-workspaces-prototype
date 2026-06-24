import { describe, expect, it } from "vitest";
import { execEnvironmentLabel, statusFor, type ExecSnapshot } from "../src/components/ExecToolView.js";

describe("ExecToolView helpers", () => {
  it("shows the resolved backend and built-in command kind from output metadata", () => {
    const output: ExecSnapshot = {
      exitCode: 0,
      stdout: "",
      stderr: "",
      metadata: {
        kind: "exec",
        backend: "shell",
        requestedBackend: null,
        cwd: "/workspace",
        commandKind: "git",
      },
    };

    expect(execEnvironmentLabel({ backend: "container" }, output)).toBe("shell · git");
  });

  it("falls back through legacy output backend, input backend, then shell", () => {
    expect(execEnvironmentLabel(undefined, { backend: "container" })).toBe("container");
    expect(execEnvironmentLabel({ backend: "container" }, null)).toBe("container");
    expect(execEnvironmentLabel(undefined, null)).toBe("shell");
  });

  it("continues to report final empty-output commands by exit status", () => {
    expect(statusFor({ exitCode: 0, stdout: "", stderr: "", stdoutEmpty: true, stderrEmpty: true })).toEqual({
      kind: "ok",
      label: "exit 0",
    });
  });
});
