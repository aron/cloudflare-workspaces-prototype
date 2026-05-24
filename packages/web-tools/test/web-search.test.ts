import { describe, expect, it, vi } from "vitest";
import { createWebSearchTool } from "../src/search/tool.js";
import type { SearchProvider, SearchResult } from "../src/search/types.js";

async function exec(tool: any, input: any) {
  return tool.execute(input, { toolCallId: "t1", messages: [] });
}

function stubProvider(behavior: (query: string, opts: any) => Promise<SearchResult[]>): SearchProvider {
  return { id: "stub", search: vi.fn(behavior) };
}

const SAMPLE: SearchResult[] = [
  { title: "A", url: "https://a.example", snippet: "alpha", source: "stub" },
  { title: "B", url: "https://b.example", snippet: "beta",  source: "stub" },
];

describe("createWebSearchTool", () => {
  it("returns provider results under a stable shape", async () => {
    const provider = stubProvider(async () => SAMPLE);
    const tool = createWebSearchTool({ provider });
    const out = await exec(tool, { query: "alpha beta" });
    expect(out.query).toBe("alpha beta");
    expect(out.provider).toBe("stub");
    expect(out.results).toEqual(SAMPLE);
  });

  it("uses defaultLimit when limit is unspecified", async () => {
    const search = vi.fn(async () => SAMPLE);
    const tool = createWebSearchTool({ provider: { id: "stub", search }, defaultLimit: 3 });
    await exec(tool, { query: "q" });
    expect(search).toHaveBeenCalledWith("q", expect.objectContaining({ limit: 3 }));
  });

  it("clamps limit to maxLimit", async () => {
    const search = vi.fn(async () => SAMPLE);
    const tool = createWebSearchTool({ provider: { id: "stub", search }, maxLimit: 4 });
    await exec(tool, { query: "q", limit: 99 });
    expect(search).toHaveBeenCalledWith("q", expect.objectContaining({ limit: 4 }));
  });

  it("rejects empty queries before hitting the provider", async () => {
    const search = vi.fn();
    const tool = createWebSearchTool({ provider: { id: "stub", search } });
    const out = await exec(tool, { query: "   " });
    expect(out.error).toMatch(/empty/i);
    expect(search).not.toHaveBeenCalled();
  });

  it("turns provider errors into a tool-level error result", async () => {
    const provider = stubProvider(async () => {
      throw new Error("Brave search returned 401");
    });
    const tool = createWebSearchTool({ provider });
    const out = await exec(tool, { query: "q" });
    expect(out.error).toMatch(/401/);
    expect(out.provider).toBe("stub");
  });
});
