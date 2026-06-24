import { tool } from "ai";
import { z } from "zod";
import { applyV4ADiff } from "../apply-diff.js";
import {
  detectLineEnding,
  generateDiffString,
  generateUnifiedPatch,
  normalizeToLF,
  restoreLineEndings,
  stripBom,
} from "../edit-diff.js";
import type { FileStore } from "../stores/types.js";

export interface ApplyPatchToolOptions {
  store: FileStore;
  /** Default 2 MiB, same as edit. */
  maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

const createFileSchema = z.object({
  type: z.literal("create_file"),
  path: z.string().describe("Path to create"),
  diff: z.string().describe("V4A create diff: every line is prefixed with +"),
}).strict();

const updateFileSchema = z.object({
  type: z.literal("update_file"),
  path: z.string().describe("Path to update"),
  diff: z.string().describe("Headerless V4A diff with @@ sections"),
}).strict();

const deleteFileSchema = z.object({
  type: z.literal("delete_file"),
  path: z.string().describe("Path to delete"),
}).strict();

const operationSchema = z.discriminatedUnion("type", [
  createFileSchema,
  updateFileSchema,
  deleteFileSchema,
]);

const inputSchema = operationSchema.describe("OpenAI apply_patch operation");

type ApplyPatchOperation = z.infer<typeof operationSchema>;

type ApplyPatchOutput =
  | {
      status: "completed";
      output: string;
      path: string;
      operation: "create_file" | "update_file" | "delete_file";
      diff?: string;
      patch?: string;
      firstChangedLine?: number | null;
    }
  | { status: "failed"; output: string; path?: string; operation?: string };

/** Best-effort coercion for wrappers that send { operation }. */
function prepareArguments(raw: unknown): ApplyPatchOperation {
  if (raw && typeof raw === "object" && "operation" in raw) {
    return (raw as { operation: unknown }).operation as ApplyPatchOperation;
  }
  return raw as ApplyPatchOperation;
}

const fileLocks = new Map<string, Promise<unknown>>();
async function withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const prev = fileLocks.get(path) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  fileLocks.set(
    path,
    next.finally(() => {
      if (fileLocks.get(path) === next) fileLocks.delete(path);
    }),
  );
  return next;
}

function failure(operation: ApplyPatchOperation | undefined, message: string): ApplyPatchOutput {
  return {
    status: "failed",
    output: `Error: ${message}`,
    path: operation?.path,
    operation: operation?.type,
  };
}

export function createApplyPatchTool(options: ApplyPatchToolOptions) {
  const { store } = options;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  return tool({
    description: [
      "Apply an OpenAI apply_patch operation using headerless V4A diffs.",
      "Use this instead of edit for file modifications when available.",
      "Operations:",
      "  create_file: create a new file; diff contains the whole file with every line prefixed by '+'.",
      "  update_file: update an existing file; diff contains @@ sections with context (' '), deletions ('-'), and additions ('+').",
      "  delete_file: delete a file at path.",
      "Keep patches small and targeted. Read the file first when unsure so context applies cleanly.",
    ].join("\n"),
    inputSchema,
    execute: async (rawInput: unknown): Promise<ApplyPatchOutput> => {
      const parsed = inputSchema.safeParse(prepareArguments(rawInput));
      if (!parsed.success) {
        return {
          status: "failed",
          output: `Error: invalid apply_patch input: ${parsed.error.message}`,
        };
      }
      const operation = parsed.data;

      return withFileLock(operation.path, async () => {
        try {
          switch (operation.type) {
            case "create_file": {
              const existing = await store.stat(operation.path);
              if (existing) return failure(operation, `File already exists at path '${operation.path}'`);
              const newContent = applyV4ADiff("", operation.diff, "create");
              const finalBytes = new TextEncoder().encode(newContent);
              if (finalBytes.byteLength > maxBytes) {
                return failure(operation, `Created content too large: ${finalBytes.byteLength} bytes exceeds ${maxBytes}`);
              }
              await store.write(operation.path, finalBytes);
              const diffResult = generateDiffString("", newContent);
              return {
                status: "completed",
                output: `Created ${operation.path}`,
                path: operation.path,
                operation: operation.type,
                diff: diffResult.diff,
                patch: generateUnifiedPatch(operation.path, "", newContent),
                firstChangedLine: diffResult.firstChangedLine,
              };
            }

            case "update_file": {
              const stat = await store.stat(operation.path);
              if (!stat) return failure(operation, `File not found at path '${operation.path}'`);
              if (stat.size > maxBytes) return failure(operation, `File too large: ${stat.size} bytes exceeds ${maxBytes}`);
              const bytes = await store.readAll(operation.path);
              if (!bytes) return failure(operation, `File not found at path '${operation.path}'`);

              const rawContent = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
              const { bom, text } = stripBom(rawContent);
              const ending = detectLineEnding(text);
              const normalized = normalizeToLF(text);
              const newNormalized = applyV4ADiff(normalized, operation.diff);
              const finalContent = bom + restoreLineEndings(newNormalized, ending);
              await store.write(operation.path, new TextEncoder().encode(finalContent), { mode: stat.mode });
              const diffResult = generateDiffString(normalized, newNormalized);
              return {
                status: "completed",
                output: `Updated ${operation.path}`,
                path: operation.path,
                operation: operation.type,
                diff: diffResult.diff,
                patch: generateUnifiedPatch(operation.path, normalized, newNormalized),
                firstChangedLine: diffResult.firstChangedLine,
              };
            }

            case "delete_file": {
              const stat = await store.stat(operation.path);
              if (!stat) return failure(operation, `File not found at path '${operation.path}'`);
              if (!store.delete) return failure(operation, "delete_file is not supported by this file store");
              const bytes = await store.readAll(operation.path);
              const baseContent = bytes ? new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes) : "";
              await store.delete(operation.path);
              const diffResult = generateDiffString(normalizeToLF(baseContent), "");
              return {
                status: "completed",
                output: `Deleted ${operation.path}`,
                path: operation.path,
                operation: operation.type,
                diff: diffResult.diff,
                patch: generateUnifiedPatch(operation.path, normalizeToLF(baseContent), ""),
                firstChangedLine: diffResult.firstChangedLine,
              };
            }
          }
        } catch (err) {
          return failure(operation, err instanceof Error ? err.message : String(err));
        }
      });
    },
  });
}
