import { z } from "zod";
import type { RunEvent, RuntimeId } from "../../shared/events";
import type { RunEventInput } from "../run-events";
import type { RuntimeAdapter } from "../runtime/adapter";

type RuntimeThinkToolName = "read" | "write" | "edit" | "exec";

type RuntimeThinkTool = {
  description: string;
  inputSchema: z.ZodType;
  execute(input: unknown): Promise<unknown>;
};

type RuntimeThinkToolSet = Record<RuntimeThinkToolName, RuntimeThinkTool>;

const readInputSchema = z.object({
  path: z.string().describe("Absolute path to read from the runtime workspace."),
});

const writeInputSchema = z.object({
  path: z.string().describe("Absolute path to write in the runtime workspace."),
  contents: z.string().describe("Complete file contents to write."),
});

const editInputSchema = z.object({
  path: z.string().describe("Absolute path to edit in the runtime workspace."),
  edits: z
    .array(
      z.object({
        oldText: z.string().describe("Exact text that appears once in the current file."),
        newText: z.string().describe("Replacement text."),
      }),
    )
    .min(1)
    .describe("Exact replacements to apply."),
});

const execInputSchema = z.object({
  command: z.string().describe("Shell command to run."),
  cwd: z.string().optional().describe("Working directory for the command."),
  timeoutMs: z.number().int().positive().optional().describe("Command timeout in milliseconds."),
});

export interface RuntimeThinkToolRecorder {
  record(input: RunEventInput): RunEvent | Promise<RunEvent>;
}

export interface RuntimeThinkToolsOptions {
  adapter: RuntimeAdapter;
  recorder: RuntimeThinkToolRecorder;
}

export function createRuntimeThinkTools({
  adapter,
  recorder,
}: RuntimeThinkToolsOptions): RuntimeThinkToolSet {
  const runtime = adapter.runtime;

  return {
    read: createRuntimeThinkTool({
      runtime,
      recorder,
      name: "read",
      description: "Read a text file from the runtime workspace.",
      inputSchema: readInputSchema,
      execute: async (input) => {
        const { path } = readInputSchema.parse(input);
        return { path, content: await adapter.files.read(path) };
      },
    }),
    write: createRuntimeThinkTool({
      runtime,
      recorder,
      name: "write",
      description: "Write a text file in the runtime workspace.",
      inputSchema: writeInputSchema,
      execute: async (input) => {
        const { path, contents } = writeInputSchema.parse(input);
        await adapter.files.write(path, contents);
        return { path, bytesWritten: byteLength(contents) };
      },
    }),
    edit: createRuntimeThinkTool({
      runtime,
      recorder,
      name: "edit",
      description: "Apply exact text replacements to a runtime workspace file.",
      inputSchema: editInputSchema,
      execute: async (input) => {
        const { path, edits } = editInputSchema.parse(input);
        await adapter.files.edit(path, edits);
        return { path, editsApplied: edits.length };
      },
    }),
    exec: createRuntimeThinkTool({
      runtime,
      recorder,
      name: "exec",
      description: "Run a shell command through the runtime.",
      inputSchema: execInputSchema,
      execute: async (input) => {
        const { command, cwd, timeoutMs } = execInputSchema.parse(input);
        const result = await adapter.exec(command, { cwd, timeoutMs });
        return { command, cwd: cwd ?? null, ...result };
      },
    }),
  };
}

export async function executeRuntimeThinkTool(
  tools: RuntimeThinkToolSet,
  name: RuntimeThinkToolName,
  input: unknown,
): Promise<unknown> {
  return tools[name].execute(input);
}

interface CreateRuntimeThinkToolOptions {
  runtime: RuntimeId;
  recorder: RuntimeThinkToolRecorder;
  name: RuntimeThinkToolName;
  description: string;
  inputSchema: z.ZodType;
  execute(input: unknown): Promise<unknown>;
}

function createRuntimeThinkTool({
  runtime,
  recorder,
  name,
  description,
  inputSchema,
  execute,
}: CreateRuntimeThinkToolOptions): RuntimeThinkTool {
  return {
    description,
    inputSchema,
    async execute(input) {
      await recorder.record({
        runtime,
        kind: "agent_tool_call",
        title: `Think requested ${name}`,
        detail: stringifyForEvent(input),
      });

      try {
        const result = await execute(input);
        await recorder.record({
          runtime,
          kind: "agent_tool_result",
          title: `Think ${name} result`,
          detail: stringifyForEvent(result),
        });
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await recorder.record({
          runtime,
          kind: "agent_tool_error",
          title: `Think ${name} error`,
          detail: message,
        });
        return { error: message };
      }
    },
  };
}

function stringifyForEvent(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function byteLength(contents: string): number {
  return new TextEncoder().encode(contents).byteLength;
}
