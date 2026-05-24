import { describe, expect, it, vi } from "vitest";
import { createWebFetchTool } from "../src/index.js";

async function exec(tool: any, input: any) {
  return tool.execute(input, { toolCallId: "t1", messages: [] });
}

function htmlResponse(body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", ...headers },
  });
}
function markdownResponse(body: string, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/markdown; charset=utf-8", ...extra },
  });
}

describe("createWebFetchTool", () => {
  it("requests Accept: text/markdown first", async () => {
    const fetcher = vi.fn().mockResolvedValue(markdownResponse("# Hi"));
    const tool = createWebFetchTool({ fetch: fetcher });
    await exec(tool, { url: "https://example.com" });
    const [, init] = fetcher.mock.calls[0];
    const accept =
      init.headers instanceof Headers ? init.headers.get("accept") : (init.headers as any)?.accept;
    expect(String(accept ?? "")).toMatch(/text\/markdown/);
  });

  it("returns markdown bodies straight through", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(markdownResponse("# Hi\nbody", { "x-markdown-tokens": "42" }));
    const tool = createWebFetchTool({ fetch: fetcher });
    const out = await exec(tool, { url: "https://example.com" });
    expect(out.markdown).toBe("# Hi\nbody");
    expect(out.convertedBy).toBe("cloudflare-zone");
    expect(out.tokens).toBe(42);
    expect(out.contentType).toMatch(/text\/markdown/);
    expect(out.truncated).toBe(false);
  });

  it("passes through text/plain bodies as fenced code", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response("hello\nworld", { headers: { "content-type": "text/plain" } }),
    );
    const tool = createWebFetchTool({ fetch: fetcher });
    const out = await exec(tool, { url: "https://example.com" });
    expect(out.markdown).toContain("hello\nworld");
    expect(out.markdown.startsWith("```")).toBe(true);
    expect(out.convertedBy).toBe("origin");
  });

  it("falls back to the AI binding for HTML responses", async () => {
    const fetcher = vi.fn().mockResolvedValue(htmlResponse("<h1>Hi</h1><p>body</p>"));
    const ai = {
      toMarkdown: vi.fn().mockResolvedValue([{ name: "doc.html", data: "# Hi\n\nbody" }]),
    };
    const tool = createWebFetchTool({ fetch: fetcher, ai: ai as any });
    const out = await exec(tool, { url: "https://example.com/page" });
    expect(ai.toMarkdown).toHaveBeenCalledTimes(1);
    expect(out.markdown).toBe("# Hi\n\nbody");
    expect(out.convertedBy).toBe("workers-ai");
  });

  it("returns an error for HTML with no AI binding", async () => {
    const fetcher = vi.fn().mockResolvedValue(htmlResponse("<p>hi</p>"));
    const tool = createWebFetchTool({ fetch: fetcher });
    const out = await exec(tool, { url: "https://example.com" });
    expect(out.error).toMatch(/HTML/i);
    expect(out.error).toMatch(/AI/i);
  });

  it("rejects SSRF targets before sending any request", async () => {
    const fetcher = vi.fn();
    const tool = createWebFetchTool({ fetch: fetcher });
    const out = await exec(tool, { url: "http://127.0.0.1/admin" });
    expect(out.error).toMatch(/loopback|private/i);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects unsupported schemes", async () => {
    const fetcher = vi.fn();
    const tool = createWebFetchTool({ fetch: fetcher });
    const out = await exec(tool, { url: "file:///etc/passwd" });
    expect(out.error).toMatch(/scheme/i);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("reports an error for unsupported content types", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "application/pdf" } }),
    );
    const tool = createWebFetchTool({ fetch: fetcher });
    const out = await exec(tool, { url: "https://example.com/x.pdf" });
    expect(out.error).toMatch(/unsupported/i);
    expect(out.contentType).toMatch(/pdf/);
  });

  it("reports non-2xx upstream responses as errors", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("not found", { status: 404 }));
    const tool = createWebFetchTool({ fetch: fetcher });
    const out = await exec(tool, { url: "https://example.com/missing" });
    expect(out.error).toMatch(/404/);
    expect(out.status).toBe(404);
  });

  it("truncates oversized markdown responses and flags it", async () => {
    const big = "# Hi\n" + "x".repeat(5000);
    const fetcher = vi.fn().mockResolvedValue(markdownResponse(big));
    const tool = createWebFetchTool({ fetch: fetcher });
    const out = await exec(tool, { url: "https://example.com", maxBytes: 1024 });
    expect(out.truncated).toBe(true);
    expect(out.markdown.length).toBeLessThanOrEqual(1100);
  });

  it("reports the final URL after redirects via Response.url", async () => {
    // Construct a Response whose `url` is set by the platform — the public
    // way to do that is `Response.redirect`, but that returns a 3xx. Build a
    // Proxy that overrides only the `url` getter.
    const base = markdownResponse("# Hi");
    const proxied = new Proxy(base, {
      get(target, prop, recv) {
        if (prop === "url") return "https://example.com/final";
        const v = Reflect.get(target, prop, target);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const fetcher = vi.fn().mockResolvedValue(proxied);
    const tool = createWebFetchTool({ fetch: fetcher });
    const out = await exec(tool, { url: "https://example.com/start" });
    expect(out.finalUrl).toBe("https://example.com/final");
  });

  it("falls back to the input URL when Response.url is empty", async () => {
    const fetcher = vi.fn().mockResolvedValue(markdownResponse("# Hi"));
    const tool = createWebFetchTool({ fetch: fetcher });
    const out = await exec(tool, { url: "https://example.com/start" });
    expect(out.finalUrl).toBe("https://example.com/start");
  });
});
