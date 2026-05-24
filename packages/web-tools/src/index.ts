import { tool } from "ai";
import { z } from "zod";
import { readResponseCapped } from "./read-capped.js";
import { validateFetchUrl } from "./ssrf.js";

/**
 * Minimal Workers AI binding surface we depend on. Typed loosely so the
 * package does not pull in `@cloudflare/workers-types` as a hard dep.
 */
export interface AiMarkdownDocument {
  name: string;
  blob: Blob;
}
export interface AiMarkdownConversionResponse {
  name: string;
  data: string;
  // The real binding includes a few more fields. We don't depend on them.
}
/**
 * Structural subset of the Cloudflare `Ai` binding's `toMarkdown`. Typed
 * loosely so a real `env.AI` binding assigns cleanly without us re-declaring
 * its full overload set.
 */
export interface AiToMarkdownBinding {
  toMarkdown: (...args: any[]) => any;
}

export interface WebFetchToolOptions {
  /** Optional Workers AI binding for HTML→markdown fallback. */
  ai?: AiToMarkdownBinding;
  /** Override for tests. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Hard cap on bytes read from the response body. Default 1 MiB. */
  maxBytes?: number;
  /** Optional user-agent. */
  userAgent?: string;
}

const DEFAULT_MAX_BYTES = 1 * 1024 * 1024;
const DEFAULT_USER_AGENT = "cloudflare-web-tools/0.1 (+https://github.com/)";

const inputSchema = z.object({
  url: z.string().describe("Absolute http(s) URL"),
  maxBytes: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Per-call byte cap. Defaults to the tool-level cap."),
});

interface FetchResult {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  markdown: string;
  bytes: number;
  truncated: boolean;
  tokens?: number;
  convertedBy: "origin" | "cloudflare-zone" | "workers-ai";
}

function fencedCode(body: string, lang: string): string {
  // Avoid ``` collisions in the body by switching to a longer fence when needed.
  let fence = "```";
  while (body.includes(fence)) fence += "`";
  return `${fence}${lang}\n${body}\n${fence}`;
}

function parseContentType(ct: string | null): { type: string; charset?: string } {
  if (!ct) return { type: "" };
  const [type, ...rest] = ct.split(";").map(s => s.trim().toLowerCase());
  const charset = rest.find(p => p.startsWith("charset="))?.slice("charset=".length);
  return { type, charset };
}

function decode(bytes: Uint8Array, charset?: string): string {
  try {
    return new TextDecoder(charset ?? "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

export function createWebFetchTool(options: WebFetchToolOptions = {}) {
  const doFetch = options.fetch ?? fetch;
  const ai = options.ai;
  const toolMaxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;

  return tool({
    description:
      "Fetch a URL and return it as Markdown. Requests Accept: text/markdown first (works on Cloudflare zones with Markdown for Agents enabled), then falls back to Workers AI for HTML conversion. Private and loopback addresses are refused.",
    inputSchema,
    execute: async ({ url, maxBytes }) => {
      const cap = Math.min(maxBytes ?? toolMaxBytes, toolMaxBytes);
      let parsed: URL;
      try {
        parsed = validateFetchUrl(url);
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }

      let res: Response;
      try {
        res = await doFetch(parsed.toString(), {
          headers: {
            accept: "text/markdown, text/plain;q=0.7, text/html;q=0.3",
            "user-agent": userAgent,
          },
          redirect: "follow",
        });
      } catch (err) {
        return { error: `fetch failed: ${err instanceof Error ? err.message : String(err)}` };
      }

      const { type, charset } = parseContentType(res.headers.get("content-type"));
      const finalUrl = res.url || parsed.toString();

      if (!res.ok) {
        // Drain to release the connection; bound by cap so a hostile origin can't OOM us.
        await readResponseCapped(res, Math.min(cap, 64 * 1024)).catch(() => {});
        return {
          error: `upstream returned ${res.status}`,
          url,
          finalUrl,
          status: res.status,
          contentType: type,
        };
      }

      const { bytes, truncated } = await readResponseCapped(res, cap);
      const tokensHeader = res.headers.get("x-markdown-tokens");
      const tokens = tokensHeader ? Number(tokensHeader) : undefined;

      // Branch on content type.
      if (type === "text/markdown") {
        const md = decode(bytes, charset);
        return ok(url, finalUrl, res.status, type, md, bytes.length, truncated, "cloudflare-zone", tokens);
      }
      if (type === "text/plain" || type === "application/json") {
        const text = decode(bytes, charset);
        const lang = type === "application/json" ? "json" : "";
        return ok(url, finalUrl, res.status, type, fencedCode(text, lang), bytes.length, truncated, "origin");
      }
      if (type === "text/html" || type === "application/xhtml+xml") {
        if (!ai) {
          return {
            error:
              "Response is HTML and no AI binding is configured for conversion. Enable Markdown for Agents on the origin zone, or pass an `ai` binding to createWebFetchTool().",
            url,
            finalUrl,
            status: res.status,
            contentType: type,
            bytes: bytes.length,
          };
        }
        const html = decode(bytes, charset);
        let md: string;
        try {
          const filename = (parsed.pathname.split("/").filter(Boolean).pop() || "page") + ".html";
          const result = await ai.toMarkdown([
            { name: filename, blob: new Blob([html], { type: "text/html" }) },
          ]);
          const first = Array.isArray(result) ? result[0] : result;
          md = first?.data ?? "";
        } catch (err) {
          return {
            error: `AI.toMarkdown failed: ${err instanceof Error ? err.message : String(err)}`,
            url,
            finalUrl,
            status: res.status,
            contentType: type,
          };
        }
        return ok(url, finalUrl, res.status, type, md, bytes.length, truncated, "workers-ai");
      }

      return {
        error: `unsupported content-type: ${type || "(none)"}`,
        url,
        finalUrl,
        status: res.status,
        contentType: type,
        bytes: bytes.length,
      };
    },
  });
}

function ok(
  url: string,
  finalUrl: string,
  status: number,
  contentType: string,
  markdown: string,
  bytes: number,
  truncated: boolean,
  convertedBy: FetchResult["convertedBy"],
  tokens?: number,
): FetchResult {
  const out: FetchResult = { url, finalUrl, status, contentType, markdown, bytes, truncated, convertedBy };
  if (tokens !== undefined && !Number.isNaN(tokens)) out.tokens = tokens;
  return out;
}

export { validateFetchUrl } from "./ssrf.js";
export { readResponseCapped } from "./read-capped.js";

// --- web search ---
export { createWebSearchTool, type WebSearchToolOptions } from "./search/tool.js";
export { createBraveSearchProvider, type BraveSearchOptions } from "./search/brave.js";
export type {
  SearchOptions,
  SearchProvider,
  SearchResult,
} from "./search/types.js";
