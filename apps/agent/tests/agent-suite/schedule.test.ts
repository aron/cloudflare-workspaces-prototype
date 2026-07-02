/**
 * DO-level tests for the `schedule` tool, driving the real create/list/cancel
 * dispatch against durable `cf_agents_schedules` storage via the
 * `invokeScheduleTool` introspection RPC.
 *
 * The pure mapping/framing logic is covered in tests/schedule-tool.test.ts;
 * here we assert the tool actually persists, lists, and cancels schedules on a
 * real Agent Durable Object.
 */
import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import type { Agent } from "../../src/agent.js";

async function freshAgent(): Promise<DurableObjectStub<Agent>> {
  const name = `agent-${Math.random().toString(36).slice(2)}`;
  return getAgentByName(env.Agent, name);
}

describe("Agent — schedule tool", () => {
  it("creates a one-off delayed task and lists it", async () => {
    const agent = await freshAgent();

    const created = await agent.invokeScheduleTool({
      command: "create",
      title: "check in",
      prompt: "Ping the user.",
      when: { type: "delay", seconds: 3600 },
    });
    expect(created.created).toBe(true);
    expect(created.kind).toBe("once");
    expect(typeof created.id).toBe("string");

    const listed = await agent.invokeScheduleTool({ command: "list" });
    const tasks = listed.tasks as Array<Record<string, unknown>>;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      id: created.id,
      title: "check in",
      kind: "once",
      cron: null,
    });
  });

  it("creates a recurring cron task with a cron field", async () => {
    const agent = await freshAgent();

    const created = await agent.invokeScheduleTool({
      command: "create",
      title: "daily backlog",
      prompt: "Summarize new issues.",
      when: { type: "cron", cron: "0 8 * * *" },
    });
    expect(created.created).toBe(true);
    expect(created.kind).toBe("recurring");

    const listed = await agent.invokeScheduleTool({ command: "list" });
    const tasks = listed.tasks as Array<Record<string, unknown>>;
    expect(tasks[0]).toMatchObject({
      title: "daily backlog",
      kind: "recurring",
      cron: "0 8 * * *",
    });
  });

  it("cancels a task by id", async () => {
    const agent = await freshAgent();

    const created = await agent.invokeScheduleTool({
      command: "create",
      title: "temp",
      prompt: "do it",
      when: { type: "delay", seconds: 120 },
    });
    const id = created.id as string;

    const cancelled = await agent.invokeScheduleTool({ command: "cancel", id });
    expect(cancelled).toMatchObject({ cancelled: true, id });

    const listed = await agent.invokeScheduleTool({ command: "list" });
    expect(listed.tasks as unknown[]).toHaveLength(0);
  });

  it("returns a correctable error for a bad cron instead of throwing", async () => {
    const agent = await freshAgent();
    const res = await agent.invokeScheduleTool({
      command: "create",
      title: "bad",
      prompt: "x",
      when: { type: "cron", cron: "not a cron" },
    });
    expect(typeof res.error).toBe("string");
    expect(res.created).toBeUndefined();
  });

  it("returns an error when create is missing fields", async () => {
    const agent = await freshAgent();
    const res = await agent.invokeScheduleTool({ command: "create", title: "x" });
    expect(res.error).toMatch(/requires title, prompt, and when/);
  });

  it("recurring create is idempotent (no duplicate rows)", async () => {
    const agent = await freshAgent();
    const input = {
      command: "create" as const,
      title: "dup",
      prompt: "same",
      when: { type: "cron" as const, cron: "0 9 * * *" },
    };
    await agent.invokeScheduleTool(input);
    await agent.invokeScheduleTool(input);

    const listed = await agent.invokeScheduleTool({ command: "list" });
    expect(listed.tasks as unknown[]).toHaveLength(1);
  });
});
