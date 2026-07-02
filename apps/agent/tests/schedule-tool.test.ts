/**
 * Unit tests for the pure `schedule` tool helpers (schedule-tool.ts).
 *
 * These cover the logic that has no Durable Object dependency: mapping the
 * model's `when` shape to the core scheduler argument, framing a fired task's
 * prompt, and rendering stored schedules for the `list` command. The DO-level
 * wiring (this.schedule / submitMessages) is exercised in the agent-suite.
 */
import { describe, it, expect } from "vitest";
import {
  MAX_DELAY_SECONDS,
  ScheduleInputError,
  describeSchedules,
  frameScheduledPrompt,
  resolveWhen,
  scheduleToolSchema,
  type StoredScheduleView,
} from "../src/schedule-tool.js";

describe("resolveWhen", () => {
  it("maps a delay to a positive integer seconds count (one-off)", () => {
    const { arg, kind } = resolveWhen({ type: "delay", seconds: 86_400 });
    expect(arg).toBe(86_400);
    expect(kind).toBe("once");
  });

  it("floors fractional delay seconds", () => {
    const { arg } = resolveWhen({ type: "delay", seconds: 90.9 });
    expect(arg).toBe(90);
  });

  it("rejects non-positive or oversized delays", () => {
    expect(() => resolveWhen({ type: "delay", seconds: 0 })).toThrow(
      ScheduleInputError,
    );
    expect(() =>
      resolveWhen({ type: "delay", seconds: MAX_DELAY_SECONDS + 1 }),
    ).toThrow(/30 days/);
  });

  it("maps an absolute future ISO time to a Date (one-off)", () => {
    const iso = new Date(Date.now() + 60_000).toISOString();
    const { arg, kind } = resolveWhen({ type: "at", iso });
    expect(arg).toBeInstanceOf(Date);
    expect((arg as Date).toISOString()).toBe(iso);
    expect(kind).toBe("once");
  });

  it("rejects an unparseable or past absolute time", () => {
    expect(() => resolveWhen({ type: "at", iso: "not-a-date" })).toThrow(
      /could not parse/,
    );
    const past = new Date(Date.now() - 60_000).toISOString();
    expect(() => resolveWhen({ type: "at", iso: past })).toThrow(
      /must be in the future/,
    );
  });

  it("passes a cron string through as recurring", () => {
    const { arg, kind } = resolveWhen({ type: "cron", cron: "0 8 * * *" });
    expect(arg).toBe("0 8 * * *");
    expect(kind).toBe("recurring");
  });

  it("trims cron and rejects an empty one (syntax left to the core)", () => {
    expect(resolveWhen({ type: "cron", cron: "  0 8 * * *  " }).arg).toBe(
      "0 8 * * *",
    );
    expect(() => resolveWhen({ type: "cron", cron: "   " })).toThrow(
      /must not be empty/,
    );
  });
});

describe("frameScheduledPrompt", () => {
  it("tags a one-off task with its title", () => {
    const text = frameScheduledPrompt({
      title: "check in",
      prompt: "Ping the user.",
      kind: "once",
    });
    expect(text).toBe('[Scheduled task "check in"]\nPing the user.');
  });

  it("marks a recurring task so the model knows it repeats", () => {
    const text = frameScheduledPrompt({
      title: "backlog",
      prompt: "Summarize new issues.",
      kind: "recurring",
    });
    expect(text).toContain("(recurring)");
    expect(text).toContain("Summarize new issues.");
  });
});

describe("describeSchedules", () => {
  const base = (over: Partial<StoredScheduleView>): StoredScheduleView => ({
    id: "s1",
    time: 1_800_000_000,
    type: "delayed",
    payload: { title: "t", prompt: "p", kind: "once" },
    ...over,
  });

  it("renders our tasks with next-run ISO and cron when recurring", () => {
    const out = describeSchedules([
      base({ id: "one", type: "delayed" }),
      base({
        id: "two",
        type: "cron",
        cron: "0 8 * * *",
        payload: { title: "daily", prompt: "go", kind: "recurring" },
      }),
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ id: "one", title: "t", kind: "once", cron: null });
    expect(out[0].nextRun).toBe(new Date(1_800_000_000 * 1000).toISOString());
    expect(out[1]).toMatchObject({
      id: "two",
      title: "daily",
      kind: "recurring",
      cron: "0 8 * * *",
    });
  });

  it("skips rows without our payload shape (framework-internal schedules)", () => {
    const out = describeSchedules([
      base({ id: "ours" }),
      base({ id: "foreign", payload: { some: "other-callback-data" } }),
      base({ id: "nullish", payload: null }),
    ]);
    expect(out.map((e) => e.id)).toEqual(["ours"]);
  });
});

describe("scheduleToolSchema", () => {
  it("accepts a well-formed create", () => {
    const parsed = scheduleToolSchema.parse({
      command: "create",
      title: "check in",
      prompt: "Ping me.",
      when: { type: "delay", seconds: 3600 },
    });
    expect(parsed.command).toBe("create");
    expect(parsed.when).toEqual({ type: "delay", seconds: 3600 });
  });

  it("accepts list and cancel", () => {
    expect(scheduleToolSchema.parse({ command: "list" }).command).toBe("list");
    expect(
      scheduleToolSchema.parse({ command: "cancel", id: "abc" }).id,
    ).toBe("abc");
  });

  it("rejects an unknown command and a malformed when", () => {
    expect(() => scheduleToolSchema.parse({ command: "nope" })).toThrow();
    expect(() =>
      scheduleToolSchema.parse({
        command: "create",
        when: { type: "delay" }, // missing seconds
      }),
    ).toThrow();
  });
});
