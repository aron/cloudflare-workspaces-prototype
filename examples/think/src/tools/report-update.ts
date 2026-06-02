/**
 * `report_update` — POST a short progress message to the caller's
 * webhook. The webhook URL is bound at tool-construction time so the
 * model never sees it; the model only supplies a `message`.
 *
 * Failures are returned, not thrown, so a flaky webhook doesn't
 * unwind the agentic loop. The system prompt forbids the model from
 * including the word `DONE` in `message` — the workflow's
 * `notify-done` step emits the terminal payload itself.
 */

import { tool } from "ai";
import { z } from "zod";

export interface ReportUpdateToolOptions {
  webhookUrl: string;
}

export function createReportUpdateTool(opts: ReportUpdateToolOptions) {
  return tool({
    description:
      "Post a short progress update to the user's webhook. Call this " +
      "whenever you finish a meaningful step (cloned the repo, found " +
      "the suspect file, formed a hypothesis, tests passing). Keep " +
      "messages to a sentence or two. Do NOT include 'DONE' — the " +
      "workflow emits the final terminal message itself.",
    inputSchema: z.object({
      message: z.string().min(1).describe("Human-readable progress update."),
    }),
    execute: async ({ message }) => {
      try {
        const res = await fetch(opts.webhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message }),
        });
        return { ok: res.ok, status: res.status };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });
}
