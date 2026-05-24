/**
 * Provider-agnostic shapes for `webSearch`. Concrete providers live next to
 * this file; the tool factory only knows about `SearchProvider`.
 */
export interface SearchResult {
  title: string;
  url: string;
  /** Provider snippet. May contain HTML tags — the tool surfaces this verbatim. */
  snippet: string;
  /** ISO-8601 publication date when the provider reports one. */
  publishedAt?: string;
  /** Provider id, propagated so the model knows what source produced the hit. */
  source?: string;
}

export interface SearchOptions {
  limit: number;
  signal?: AbortSignal;
}

export interface SearchProvider {
  /** Stable identifier surfaced in tool results — useful for debugging. */
  readonly id: string;
  search(query: string, opts: SearchOptions): Promise<SearchResult[]>;
}
