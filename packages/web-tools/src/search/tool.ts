import { tool } from "ai";
import { z } from "zod";
import type { SearchProvider, SearchResult } from "./types.js";

export interface WebSearchToolOptions {
  provider: SearchProvider;
  /** Limit applied when the model omits `limit`. Default 5. */
  defaultLimit?: number;
  /** Upper bound regardless of what the model asks for. Default 10. */
  maxLimit?: number;
}

const inputSchema = z.object({
  query: z.string().describe("Search query. Brave search operators (site:, filetype:, quoted phrases, -term) are honored."),
  limit: z.number().int().positive().optional().describe("Maximum number of results (capped by the tool's maxLimit)."),
});

interface SearchToolResult {
  query: string;
  provider: string;
  results: SearchResult[];
}
interface SearchToolError {
  query: string;
  provider: string;
  error: string;
}

export function createWebSearchTool(options: WebSearchToolOptions) {
  const { provider } = options;
  const defaultLimit = options.defaultLimit ?? 5;
  const maxLimit = options.maxLimit ?? 10;

  return tool({
    description:
      "Search the web and return a list of result links with snippets. Use this to find URLs to feed into webFetch.",
    inputSchema,
    execute: async ({ query, limit }, ctx): Promise<SearchToolResult | SearchToolError> => {
      const q = query.trim();
      if (!q) return { query, provider: provider.id, error: "Query must not be empty." };

      const requested = limit ?? defaultLimit;
      const clamped = Math.min(maxLimit, Math.max(1, requested));

      try {
        const results = await provider.search(q, {
          limit: clamped,
          signal: (ctx as any)?.abortSignal,
        });
        return { query: q, provider: provider.id, results };
      } catch (err) {
        return {
          query: q,
          provider: provider.id,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });
}
