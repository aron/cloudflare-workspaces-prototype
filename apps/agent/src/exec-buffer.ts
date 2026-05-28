/**
 * Accumulates LogEvent chunks from a sandbox-SDK process stream and
 * produces cumulative snapshots the agent yields back through the AI
 * SDK's tool-streaming machinery.
 *
 * Pure data structure. Each `apply(event)` mutates the buffer; each
 * `snapshot(processId, overrides?)` returns a fresh, JSON-serializable
 * state object.
 *
 * Design notes:
 *
 *   - stdout/stderr are stored as strings, appended-to per chunk.
 *     The sandbox SDK delivers LogEvent.data already UTF-8 decoded,
 *     so we don't have to deal with split codepoints here. (If that
 *     ever changes we can swap in a TextDecoder with stream mode.)
 *   - 2 MiB cap per side. Excess bytes are dropped and stdoutTruncated /
 *     stderrTruncated flags are set. Keeps a runaway `yes` from
 *     filling DO storage.
 *   - Binary detection: a single NUL byte (\x00) on either side flips
 *     stdoutBinary / stderrBinary. The captured text for that side is
 *     dropped and subsequent chunks are ignored for that side. Sticky.
 *   - `exit` events set running=false + exitCode.
 *   - `error` events set running=false + error.details. These are
 *     tool-level errors (process couldn't spawn, sandbox dropped,
 *     etc.) — distinct from a non-zero exit code, which is a normal
 *     program outcome.
 */

export interface LogEvent {
  type: "stdout" | "stderr" | "exit" | "error";
  data: string;
  timestamp: string;
  processId: string;
  sessionId?: string;
  exitCode?: number;
}

export interface ExecSnapshot {
  processId: string;
  running: boolean;
  stdout: string;
  stderr: string;
  stdoutTruncated?: true;
  stderrTruncated?: true;
  stdoutBinary?: true;
  stderrBinary?: true;
  exitCode?: number;
  durationMs?: number;
  error?: { details: string };
}

export interface SnapshotOverrides {
  exitCode?: number;
  error?: { details: string };
  durationMs?: number;
}

const MAX_BYTES = 2 * 1024 * 1024;

export class ExecOutputBuffer {
  private _stdout = "";
  private _stderr = "";
  private _stdoutTruncated = false;
  private _stderrTruncated = false;
  private _stdoutBinary = false;
  private _stderrBinary = false;
  private _exited = false;
  private _exitCode: number | undefined;
  private _error: { details: string } | undefined;

  apply(event: LogEvent): void {
    switch (event.type) {
      case "stdout":
        this._appendStdout(event.data);
        return;
      case "stderr":
        this._appendStderr(event.data);
        return;
      case "exit":
        this._exited = true;
        this._exitCode = event.exitCode;
        return;
      case "error":
        this._exited = true;
        this._error = { details: event.data };
        return;
    }
  }

  snapshot(processId: string, overrides: SnapshotOverrides = {}): ExecSnapshot {
    const exited = this._exited || overrides.exitCode !== undefined || overrides.error !== undefined;
    const snap: ExecSnapshot = {
      processId,
      running: !exited,
      stdout: this._stdoutBinary ? "" : this._stdout,
      stderr: this._stderrBinary ? "" : this._stderr,
    };
    if (this._stdoutTruncated) snap.stdoutTruncated = true;
    if (this._stderrTruncated) snap.stderrTruncated = true;
    if (this._stdoutBinary) snap.stdoutBinary = true;
    if (this._stderrBinary) snap.stderrBinary = true;
    if (overrides.exitCode !== undefined) snap.exitCode = overrides.exitCode;
    else if (this._exitCode !== undefined) snap.exitCode = this._exitCode;
    if (overrides.error) snap.error = overrides.error;
    else if (this._error) snap.error = this._error;
    if (overrides.durationMs !== undefined) snap.durationMs = overrides.durationMs;
    return snap;
  }

  private _appendStdout(data: string): void {
    if (this._stdoutBinary) return;
    if (data.includes("\0")) {
      this._stdoutBinary = true;
      this._stdout = "";
      return;
    }
    if (this._stdout.length >= MAX_BYTES) {
      this._stdoutTruncated = true;
      return;
    }
    const room = MAX_BYTES - this._stdout.length;
    if (data.length <= room) {
      this._stdout += data;
    } else {
      this._stdout += data.slice(0, room);
      this._stdoutTruncated = true;
    }
  }

  private _appendStderr(data: string): void {
    if (this._stderrBinary) return;
    if (data.includes("\0")) {
      this._stderrBinary = true;
      this._stderr = "";
      return;
    }
    if (this._stderr.length >= MAX_BYTES) {
      this._stderrTruncated = true;
      return;
    }
    const room = MAX_BYTES - this._stderr.length;
    if (data.length <= room) {
      this._stderr += data;
    } else {
      this._stderr += data.slice(0, room);
      this._stderrTruncated = true;
    }
  }
}
