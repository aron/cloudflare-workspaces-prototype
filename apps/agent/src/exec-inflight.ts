/**
 * Per-DO bookkeeping for in-flight exec calls.
 *
 * When the agent starts a long-running process via
 * `workspace.startProcess`, the DO may be evicted before the process
 * finishes. The next `onStart` needs to know which processes were
 * mid-flight so it can reattach (or close them out with an error if
 * the sandbox has lost them).
 *
 * Stored in a small SQLite table on the DO's own storage. Schema is
 * tiny enough that we don't need migrations.
 *
 * The class accepts a minimal SqlStorage-like interface so it can be
 * unit-tested against node:sqlite without standing up a Durable
 * Object.
 */

export interface SqlStorageLike {
  exec<T = Record<string, unknown>>(sql: string, ...bindings: unknown[]): Iterable<T>;
}

export interface ExecInflightRow {
  toolCallId: string;
  processId: string;
  startedAt: number;
}

interface RawRow {
  tool_call_id: string;
  process_id: string;
  started_at: number;
}

export class ExecInflight {
  constructor(private readonly sql: SqlStorageLike) {}

  /** Create the table if it doesn't exist. Safe to call repeatedly. */
  ensureTable(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS _exec_inflight (
        tool_call_id TEXT PRIMARY KEY,
        process_id   TEXT NOT NULL,
        started_at   INTEGER NOT NULL
      )
    `);
  }

  /** Record (or overwrite) a tool-call → process mapping. */
  record(toolCallId: string, processId: string): void {
    this.sql.exec(
      `INSERT INTO _exec_inflight (tool_call_id, process_id, started_at)
       VALUES (?, ?, ?)
       ON CONFLICT(tool_call_id) DO UPDATE
         SET process_id = excluded.process_id,
             started_at = excluded.started_at`,
      toolCallId,
      processId,
      Date.now(),
    );
  }

  /** Drop a row by tool-call id. No-op if it doesn't exist. */
  clear(toolCallId: string): void {
    this.sql.exec(
      `DELETE FROM _exec_inflight WHERE tool_call_id = ?`,
      toolCallId,
    );
  }

  /** Look up one row by tool-call id. */
  get(toolCallId: string): ExecInflightRow | null {
    const rows = [...this.sql.exec<RawRow>(
      `SELECT tool_call_id, process_id, started_at
       FROM _exec_inflight
       WHERE tool_call_id = ?`,
      toolCallId,
    )];
    if (rows.length === 0) return null;
    return toRow(rows[0]);
  }

  /** All rows. Used by `onStart` recovery. */
  list(): ExecInflightRow[] {
    const rows = [...this.sql.exec<RawRow>(
      `SELECT tool_call_id, process_id, started_at FROM _exec_inflight
       ORDER BY started_at ASC`,
    )];
    return rows.map(toRow);
  }
}

function toRow(r: RawRow): ExecInflightRow {
  return {
    toolCallId: r.tool_call_id,
    processId:  r.process_id,
    startedAt:  r.started_at,
  };
}
