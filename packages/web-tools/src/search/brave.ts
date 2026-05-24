import type { SearchOptions, SearchProvider, SearchResult } from "./types.js";

export interface BraveSearchOptions {
  /** API key from the Brave Search API dashboard. */
  apiKey: string;
  /** Override for tests. Defaults to global `fetch`. */
  fetch?: typeof fetch;
  /** Override the endpoint (defaults to the public web search URL). */
  endpoint?: string;
}

const DEFAULT_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const BRAVE_MAX_COUNT = 20;

/** Slice of Brave's web/search response we care about. Anything else is ignored. */
interface BraveWebResult {
  title?: string;
  url?: string;
  description?: string;
  page_age?: string;
}
interface BraveResponse {
  web?: { results?: BraveWebResult[] };
}

export function createBraveSearchProvider(options: BraveSearchOptions): SearchProvider {
  const doFetch = options.fetch ?? fetch;
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;

  return {
    id: "brave",
    async search(query: string, opts: SearchOptions): Promise<SearchResult[]> {
      const count = Math.max(1, Math.min(BRAVE_MAX_COUNT, Math.floor(opts.limit)));
      const url = new URL(endpoint);
      url.searchParams.set("q", query);
      url.searchParams.set("count", String(count));

      const res = await doFetch(url.toString(), {
        method: "GET",
        headers: {
          accept: "application/json",
          "x-subscription-token": options.apiKey,
        },
        signal: opts.signal,
      });

      if (!res.ok) {
        // Drain so the connection releases; we don't need the body.
        await res.text().catch(() => {});
        throw new Error(`Brave search returned ${res.status}`);
      }

      const body = (await res.json()) as BraveResponse;
      const raw = body.web?.results ?? [];
      const results: SearchResult[] = [];
      for (const r of raw) {
        if (!r.url || !r.title) continue;
        const item: SearchResult = {
          title: r.title,
          url: r.url,
          snippet: r.description ?? "",
          source: "brave",
        };
        if (r.page_age) item.publishedAt = r.page_age;
        results.push(item);
      }
      return results;
    },
  };
}
