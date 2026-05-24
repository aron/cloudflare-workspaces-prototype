import { describe, expect, it, vi } from "vitest";
import { createBraveSearchProvider } from "../src/search/brave.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const BRAVE_FIXTURE = {
  query: { original: "rust async", more_results_available: true },
  web: {
    results: [
      {
        title: "Async programming in Rust",
        url: "https://example.com/rust-async",
        description: "An <strong>overview</strong> of async/await in Rust.",
        page_age: "2024-08-12T00:00:00",
      },
      {
        title: "Tokio tutorial",
        url: "https://example.com/tokio",
        description: "Getting started with the Tokio runtime.",
      },
    ],
  },
};

describe("createBraveSearchProvider", () => {
  it("sends q, count, and the subscription token to the Brave endpoint", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(BRAVE_FIXTURE));
    const provider = createBraveSearchProvider({ apiKey: "k", fetch: fetcher });
    await provider.search("rust async", { limit: 5 });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0];
    const u = new URL(url as string);
    expect(u.origin + u.pathname).toBe("https://api.search.brave.com/res/v1/web/search");
    expect(u.searchParams.get("q")).toBe("rust async");
    expect(u.searchParams.get("count")).toBe("5");
    const headers =
      init.headers instanceof Headers ? Object.fromEntries(init.headers) : (init.headers as any);
    expect(headers["x-subscription-token"] ?? headers["X-Subscription-Token"]).toBe("k");
    expect((headers["accept"] ?? headers["Accept"]).toLowerCase()).toContain("application/json");
  });

  it("maps Brave's response shape to SearchResult[]", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(BRAVE_FIXTURE));
    const provider = createBraveSearchProvider({ apiKey: "k", fetch: fetcher });
    const results = await provider.search("rust async", { limit: 5 });
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      title: "Async programming in Rust",
      url: "https://example.com/rust-async",
      // Snippets stay verbatim — minimal-tool decision.
      snippet: "An <strong>overview</strong> of async/await in Rust.",
      publishedAt: "2024-08-12T00:00:00",
      source: "brave",
    });
    expect(results[1].publishedAt).toBeUndefined();
  });

  it("clamps limit to Brave's max of 20", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(BRAVE_FIXTURE));
    const provider = createBraveSearchProvider({ apiKey: "k", fetch: fetcher });
    await provider.search("q", { limit: 500 });
    const [url] = fetcher.mock.calls[0];
    expect(new URL(url as string).searchParams.get("count")).toBe("20");
  });

  it("returns an empty array when the response has no web results", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ web: {} }));
    const provider = createBraveSearchProvider({ apiKey: "k", fetch: fetcher });
    expect(await provider.search("q", { limit: 5 })).toEqual([]);
  });

  it("throws on non-2xx responses with the upstream status", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ error: "bad key" }, 401));
    const provider = createBraveSearchProvider({ apiKey: "k", fetch: fetcher });
    await expect(provider.search("q", { limit: 5 })).rejects.toThrow(/401/);
  });

  it("propagates AbortSignal to fetch", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(BRAVE_FIXTURE));
    const provider = createBraveSearchProvider({ apiKey: "k", fetch: fetcher });
    const ac = new AbortController();
    await provider.search("q", { limit: 5, signal: ac.signal });
    const [, init] = fetcher.mock.calls[0];
    expect(init.signal).toBe(ac.signal);
  });

  it("exposes provider id 'brave'", () => {
    const provider = createBraveSearchProvider({ apiKey: "k", fetch: vi.fn() });
    expect(provider.id).toBe("brave");
  });
});
