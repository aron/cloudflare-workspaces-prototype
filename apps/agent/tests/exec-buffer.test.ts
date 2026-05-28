/**
 * Pure-function tests for ExecOutputBuffer — accumulates LogEvent
 * chunks from a sandbox-SDK process stream, decodes them as UTF-8,
 * caps stdout/stderr at 2 MiB per side, and flags binary content
 * once detected.
 *
 * Tested in isolation from the sandbox so we don't need a live
 * container — the buffer takes the same LogEvent shape the SDK
 * yields.
 */
import { describe, it, expect } from "vitest";
import { ExecOutputBuffer, type LogEvent } from "../src/exec-buffer.js";

const stdout = (data: string): LogEvent => ({
  type: "stdout", data, timestamp: "", processId: "p",
});
const stderr = (data: string): LogEvent => ({
  type: "stderr", data, timestamp: "", processId: "p",
});
const exit = (code: number): LogEvent => ({
  type: "exit", data: "", exitCode: code, timestamp: "", processId: "p",
});
const errorEvent = (msg: string): LogEvent => ({
  type: "error", data: msg, timestamp: "", processId: "p",
});

describe("ExecOutputBuffer — basics", () => {
  it("starts empty and not exited", () => {
    const b = new ExecOutputBuffer();
    const s = b.snapshot("p1");
    expect(s).toEqual({
      processId: "p1",
      running: true,
      stdout: "",
      stderr: "",
    });
  });

  it("appends stdout chunks in order", () => {
    const b = new ExecOutputBuffer();
    b.apply(stdout("hello "));
    b.apply(stdout("world"));
    expect(b.snapshot("p").stdout).toBe("hello world");
  });

  it("keeps stdout and stderr separate", () => {
    const b = new ExecOutputBuffer();
    b.apply(stdout("out"));
    b.apply(stderr("err"));
    const s = b.snapshot("p");
    expect(s.stdout).toBe("out");
    expect(s.stderr).toBe("err");
  });

  it("decodes UTF-8 multibyte sequences correctly across chunks", () => {
    const b = new ExecOutputBuffer();
    // "café" — the 'é' is two bytes; split mid-codepoint.
    b.apply(stdout("caf\u00e9 ok"));
    expect(b.snapshot("p").stdout).toBe("café ok");
  });
});

describe("ExecOutputBuffer — exit and error", () => {
  it("marks exit with the code and stops running", () => {
    const b = new ExecOutputBuffer();
    b.apply(stdout("done"));
    b.apply(exit(0));
    const s = b.snapshot("p");
    expect(s.running).toBe(false);
    expect(s.exitCode).toBe(0);
  });

  it("non-zero exit codes are surfaced unchanged", () => {
    const b = new ExecOutputBuffer();
    b.apply(exit(137));
    expect(b.snapshot("p")).toMatchObject({ running: false, exitCode: 137 });
  });

  it("records error events as the tool error field", () => {
    const b = new ExecOutputBuffer();
    b.apply(errorEvent("EACCES: command not found"));
    const s = b.snapshot("p");
    expect(s.error).toEqual({ details: "EACCES: command not found" });
    expect(s.running).toBe(false);
  });
});

describe("ExecOutputBuffer — caps", () => {
  it("caps stdout at 2 MiB and sets stdoutTruncated", () => {
    const b = new ExecOutputBuffer();
    const big = "x".repeat(3 * 1024 * 1024);
    b.apply(stdout(big));
    const s = b.snapshot("p");
    expect(s.stdout.length).toBe(2 * 1024 * 1024);
    expect(s.stdoutTruncated).toBe(true);
  });

  it("caps stderr independently of stdout", () => {
    const b = new ExecOutputBuffer();
    b.apply(stdout("x".repeat(1000)));
    b.apply(stderr("y".repeat(3 * 1024 * 1024)));
    const s = b.snapshot("p");
    expect(s.stdout.length).toBe(1000);
    expect(s.stderrTruncated).toBe(true);
  });

  it("further chunks after a cap are dropped silently", () => {
    const b = new ExecOutputBuffer();
    b.apply(stdout("x".repeat(2 * 1024 * 1024)));
    b.apply(stdout("more"));
    expect(b.snapshot("p").stdout.length).toBe(2 * 1024 * 1024);
  });
});

describe("ExecOutputBuffer — binary detection", () => {
  it("flags stdoutBinary when a NUL byte arrives", () => {
    const b = new ExecOutputBuffer();
    b.apply(stdout("ok\0bad"));
    const s = b.snapshot("p");
    expect(s.stdoutBinary).toBe(true);
    expect(s.stdout).toBe("");
  });

  it("flags stderrBinary independently", () => {
    const b = new ExecOutputBuffer();
    b.apply(stdout("printable"));
    b.apply(stderr("a\0b"));
    const s = b.snapshot("p");
    expect(s.stdoutBinary).toBeUndefined();
    expect(s.stderrBinary).toBe(true);
  });

  it("once flagged binary stays binary even if later chunks would be text", () => {
    const b = new ExecOutputBuffer();
    b.apply(stdout("\0"));
    b.apply(stdout("hello"));
    expect(b.snapshot("p").stdoutBinary).toBe(true);
    expect(b.snapshot("p").stdout).toBe("");
  });
});

describe("ExecOutputBuffer — snapshot semantics", () => {
  it("snapshot is idempotent", () => {
    const b = new ExecOutputBuffer();
    b.apply(stdout("hi"));
    expect(b.snapshot("p")).toEqual(b.snapshot("p"));
  });

  it("snapshot returns the supplied processId", () => {
    const b = new ExecOutputBuffer();
    expect(b.snapshot("abc").processId).toBe("abc");
  });

  it("overrides field on snapshot lets the caller stamp aborted/timed-out states", () => {
    const b = new ExecOutputBuffer();
    b.apply(stdout("ran a bit"));
    const s = b.snapshot("p", {
      exitCode: 143,
      error: { details: "aborted" },
    });
    expect(s.exitCode).toBe(143);
    expect(s.error).toEqual({ details: "aborted" });
    expect(s.running).toBe(false);
  });
});
