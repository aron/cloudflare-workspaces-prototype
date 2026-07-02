/**
 * Pure helpers for the `schedule` tool.
 *
 * The agent can schedule future work — a one-off reminder ("check in 24h") or
 * a recurring job ("every day at 08:00 summarize the backlog"). The tool is a
 * thin, model-facing wrapper over the base `Agent`'s durable scheduling API
 * (`this.schedule()` / `listSchedules()` / `cancelSchedule()`), which is backed
 * by the `cf_agents_schedules` table and Durable Object alarms.
 *
 * This module holds the logic that has no DO dependencies so it can be unit
 * tested in isolation:
 *   - the tool input schema (a single tool with a `command` discriminator),
 *   - mapping the model's `when` shape to the core `schedule()` argument,
 *   - framing the stored prompt into the user message the fired callback
 *     submits, and
 *   - rendering a stored schedule for the `list` command.
 *
 * Timezone note: the core scheduler evaluates cron expressions and absolute
 * times in **UTC**. The tool description and system prompt say so; callers must
 * convert wall-clock intents to UTC themselves.
 */
import { z } from "zod";

/** DO alarms cap scheduling at 30 days out; mirror that for `delay`. */
export const MAX_DELAY_SECONDS = 30 * 24 * 60 * 60;

/**
 * Payload persisted on the schedule row and handed back to the callback when
 * the alarm fires. Kept small and JSON-serializable. `title` and the original
 * `when` ride here so `list` can render them without a separate table.
 */
export interface SchedulePayload {
  /** Short human label, e.g. "backlog summary". */
  title: string;
  /** What the agent should do when the task fires. */
  prompt: string;
  /** One-off vs recurring — drives framing and list output. */
  kind: "once" | "recurring";
}

/**
 * The `when` shape the model provides. Discriminated by `type` so each variant
 * carries exactly the field it needs.
 */
export const whenSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("delay"),
    seconds: z
      .number()
      .int()
      .positive()
      .describe("Seconds from now until the one-off task fires, e.g. 86400 for 24 hours."),
  }),
  z.object({
    type: z.literal("at"),
    iso: z
      .string()
      .describe("Absolute UTC time for a one-off task, ISO-8601, e.g. '2026-07-02T08:00:00Z'."),
  }),
  z.object({
    type: z.literal("cron"),
    cron: z
      .string()
      .describe(
        "Standard 5-field cron expression, evaluated in UTC, for a recurring task. " +
          "e.g. '0 8 * * *' = every day at 08:00 UTC.",
      ),
  }),
]);

export type WhenInput = z.infer<typeof whenSchema>;

/**
 * Input schema for the single `schedule` tool. A `command` discriminator
 * selects the sub-command; the other fields are validated per-command at
 * runtime (a flat schema keeps the tool call simple for the model, which
 * handles top-level optional fields more reliably than nested unions across
 * the whole input).
 */
export const scheduleToolSchema = z.object({
  command: z
    .enum(["create", "list", "cancel"])
    .describe(
      "create = schedule a new task; list = show this thread's scheduled tasks; " +
        "cancel = remove a task by id.",
    ),
  title: z
    .string()
    .min(1)
    .max(120)
    .optional()
    .describe("create: short label for the task, e.g. 'backlog summary'."),
  prompt: z
    .string()
    .min(1)
    .optional()
    .describe(
      "create: the instruction the agent should act on when the task fires. " +
        "Written as if the user just asked it, e.g. 'Summarize new issues in the backlog.'",
    ),
  when: whenSchema
    .optional()
    .describe("create: when the task should fire (delay, absolute UTC time, or cron)."),
  id: z
    .string()
    .optional()
    .describe("cancel: the id of the task to remove (from a prior create/list)."),
});

export type ScheduleToolInput = z.infer<typeof scheduleToolSchema>;

/** Thrown for user-correctable input errors; the tool returns `{ error }`. */
export class ScheduleInputError extends Error {}

/**
 * Map the model's `when` to the argument the core `schedule()` accepts:
 *   - Date   → one-off absolute (`type: "scheduled"`)
 *   - number → one-off delay in seconds (`type: "delayed"`)
 *   - string → recurring cron (`type: "cron"`)
 *
 * Also returns the `kind` so the caller can persist it in the payload. Throws
 * `ScheduleInputError` for malformed input; cron *syntax* is left to the core
 * (`parseCronExpression`), which throws when it can't parse.
 */
export function resolveWhen(when: WhenInput): {
  arg: Date | number | string;
  kind: SchedulePayload["kind"];
} {
  switch (when.type) {
    case "delay": {
      if (!Number.isFinite(when.seconds) || when.seconds <= 0) {
        throw new ScheduleInputError("delay seconds must be a positive number");
      }
      if (when.seconds > MAX_DELAY_SECONDS) {
        throw new ScheduleInputError(
          `delay seconds cannot exceed ${MAX_DELAY_SECONDS} (30 days)`,
        );
      }
      return { arg: Math.floor(when.seconds), kind: "once" };
    }
    case "at": {
      const date = new Date(when.iso);
      if (Number.isNaN(date.getTime())) {
        throw new ScheduleInputError(`could not parse ISO time: ${when.iso}`);
      }
      if (date.getTime() <= Date.now()) {
        throw new ScheduleInputError("absolute time must be in the future");
      }
      return { arg: date, kind: "once" };
    }
    case "cron": {
      const cron = when.cron.trim();
      if (!cron) {
        throw new ScheduleInputError("cron expression must not be empty");
      }
      return { arg: cron, kind: "recurring" };
    }
  }
}

/**
 * Frame a fired schedule's stored prompt into the user message the callback
 * submits. The prefix tells the assistant this turn was triggered by a
 * scheduled task (not a live human), so it can act proactively and, for a
 * recurring job, knows it will run again.
 */
export function frameScheduledPrompt(payload: SchedulePayload): string {
  const tag =
    payload.kind === "recurring"
      ? `[Scheduled task "${payload.title}" (recurring)]`
      : `[Scheduled task "${payload.title}"]`;
  return `${tag}\n${payload.prompt}`;
}

/** Minimal shape of a core `Schedule` row we render for `list`. */
export interface StoredScheduleView {
  id: string;
  /** Unix seconds of the next (or one-off) execution. */
  time: number;
  type: "scheduled" | "delayed" | "cron" | "interval";
  cron?: string;
  payload: unknown;
}

/** One entry in the `list` command's response. */
export interface ScheduleListEntry {
  id: string;
  title: string;
  kind: SchedulePayload["kind"];
  /** ISO-8601 UTC of the next run. */
  nextRun: string;
  /** Cron expression for recurring tasks, else null. */
  cron: string | null;
}

/** Best-effort extraction of our payload from a stored schedule row. */
function readPayload(payload: unknown): SchedulePayload | null {
  if (payload && typeof payload === "object") {
    const p = payload as Record<string, unknown>;
    if (typeof p.title === "string" && typeof p.prompt === "string") {
      return {
        title: p.title,
        prompt: p.prompt,
        kind: p.kind === "recurring" ? "recurring" : "once",
      };
    }
  }
  return null;
}

/**
 * Render stored schedules for the `list` command. Rows without our payload
 * shape (e.g. framework-internal schedules) are skipped so the model only
 * sees tasks it created through this tool.
 */
export function describeSchedules(
  schedules: readonly StoredScheduleView[],
): ScheduleListEntry[] {
  const entries: ScheduleListEntry[] = [];
  for (const s of schedules) {
    const payload = readPayload(s.payload);
    if (!payload) continue;
    entries.push({
      id: s.id,
      title: payload.title,
      kind: payload.kind,
      nextRun: new Date(s.time * 1000).toISOString(),
      cron: s.type === "cron" ? (s.cron ?? null) : null,
    });
  }
  return entries;
}
