/**
 * SQLite-backed `ForkRegistry` for the agent's Durable Object.
 *
 * Stores one row per working-tree dir → per-session Artifacts fork.
 * Used by `git_push` and `git_share` so the same fork is reused across
 * tool calls and DO restarts.
 *
 * Schema lives on the DO's own `sql` handle (the same one Workspace
 * uses, but in its own private table). One small write per `git_push`
 * call; reads are constant-time.
 */

import type { ForkRecord, ForkRegistry } from "@cloudflare/workspace/git";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS _git_forks (
  dir                     TEXT PRIMARY KEY,
  baseline_name           TEXT NOT NULL,
  fork_name               TEXT NOT NULL,
  fork_remote             TEXT NOT NULL,
  default_branch          TEXT NOT NULL,
  write_token             TEXT NOT NULL,
  write_token_expires_at  INTEGER NOT NULL
);
`;

type Row = {
  dir:                    string;
  baseline_name:          string;
  fork_name:              string;
  fork_remote:            string;
  default_branch:         string;
  write_token:            string;
  write_token_expires_at: number;
} & Record<string, SqlStorageValue>;

export function createDoForkRegistry(sql: SqlStorage): ForkRegistry {
  sql.exec(SCHEMA);
  return {
    get(dir: string): ForkRecord | null {
      const rows = [...sql.exec<Row>(`SELECT * FROM _git_forks WHERE dir = ?`, dir)];
      if (!rows.length) return null;
      const r = rows[0];
      return {
        dir: r.dir,
        baselineName: r.baseline_name,
        forkName:     r.fork_name,
        forkRemote:   r.fork_remote,
        defaultBranch: r.default_branch,
        writeToken:   r.write_token,
        writeTokenExpiresAt: r.write_token_expires_at,
      };
    },
    upsert(record: ForkRecord): void {
      sql.exec(
        `INSERT OR REPLACE INTO _git_forks
           (dir, baseline_name, fork_name, fork_remote, default_branch, write_token, write_token_expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        record.dir,
        record.baselineName,
        record.forkName,
        record.forkRemote,
        record.defaultBranch,
        record.writeToken,
        record.writeTokenExpiresAt,
      );
    },
    delete(dir: string): void {
      sql.exec(`DELETE FROM _git_forks WHERE dir = ?`, dir);
    },
  };
}
