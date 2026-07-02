/**
 * Split storage backend for the Cloudflare MCP OAuth provider.
 *
 * `DurableObjectOAuthClientProvider` (from `agents`) persists everything through
 * a single `DurableObjectStorage`-shaped handle. We want two different homes for
 * its two classes of data:
 *
 *   - Long-lived, per-user credentials — OAuth **tokens** and the dynamically
 *     registered **client info** — belong in a dedicated **KV namespace**,
 *     keyed by `userId`, so a user authorizes Cloudflare once and every thread
 *     (Agent DO) they touch can read the same token. KV is the Cloudflare-
 *     recommended store for credentials and is encrypted at rest.
 *
 *   - Transient OAuth **flow state** — the `state` nonce and the PKCE
 *     `code_verifier` — must be strongly consistent (written when the flow
 *     starts, read back seconds later in the callback) and always complete in
 *     the same Agent DO that started the flow. KV's eventual consistency would
 *     intermittently break the exchange, so these stay in **DO-local storage**.
 *
 * This adapter presents the `DurableObjectStorage` surface the provider uses
 * (`get` / `put` / `delete` / `list`) and routes each key to the right backend.
 * Tokens are stored WITHOUT a KV expiration TTL: eviction is driven by the
 * OAuth server (a failed refresh → re-auth), never by KV expiring a still-valid
 * refresh token out from under us.
 */

/** The provider only ever calls `list()` with a `prefix`. */
interface ListOptions {
  prefix?: string;
}

/** Minimal KV surface we depend on (subset of `KVNamespace`). */
export interface KvLike {
  get(key: string, type: "json"): Promise<unknown>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Minimal DO-storage surface we depend on for transient flow state. */
export interface DoStorageLike {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T = unknown>(key: string, value: T): Promise<void>;
  delete(key: string | string[]): Promise<boolean | number>;
  list<T = unknown>(options?: ListOptions): Promise<Map<string, T>>;
}

/**
 * Decide whether a provider key holds a long-lived credential (→ KV) or
 * transient flow state (→ DO storage). The provider's key scheme is
 * `/{clientName}/{serverId}/{clientId}/{suffix}`; we match on the suffix.
 */
export function isCredentialKey(key: string): boolean {
  return key.includes("/token") || key.includes("/client_info/");
}

/**
 * Storage adapter implementing the subset of `DurableObjectStorage` that
 * `DurableObjectOAuthClientProvider` uses, splitting credential keys to KV
 * (namespaced per user) and transient keys to DO-local storage.
 *
 * The KV key is the provider key prefixed with the owning `userId`, so one KV
 * namespace cleanly partitions every user's Cloudflare tokens:
 *   `u/<userId>//<clientName>/<serverId>/<clientId>/token`
 */
export class SplitOAuthStorage {
  /**
   * `userId` may be a thunk: when the provider is created (e.g. during
   * restore-on-wake) its `serverId` — which encodes the user — is set *after*
   * construction, so credential keys resolve the user lazily at get/put time.
   */
  constructor(
    private readonly kv: KvLike,
    private readonly local: DoStorageLike,
    private readonly userId: string | (() => string),
  ) {}

  /** Namespace a credential key under the owning user. */
  private kvKey(key: string): string {
    const uid = typeof this.userId === "function" ? this.userId() : this.userId;
    return `u/${uid}/${key}`;
  }

  async get<T = unknown>(key: string): Promise<T | undefined> {
    if (isCredentialKey(key)) {
      const value = (await this.kv.get(this.kvKey(key), "json")) as T | null;
      return value ?? undefined;
    }
    return this.local.get<T>(key);
  }

  async put<T = unknown>(key: string, value: T): Promise<void> {
    if (isCredentialKey(key)) {
      // No expiration TTL — the refresh token must outlive KV, and eviction is
      // driven by OAuth refresh failure, not by KV.
      await this.kv.put(this.kvKey(key), JSON.stringify(value));
      return;
    }
    await this.local.put(key, value);
  }

  async delete(key: string | string[]): Promise<boolean | number> {
    const keys = Array.isArray(key) ? key : [key];
    let removed = 0;
    const localKeys: string[] = [];
    for (const k of keys) {
      if (isCredentialKey(k)) {
        await this.kv.delete(this.kvKey(k));
        removed++;
      } else {
        localKeys.push(k);
      }
    }
    if (localKeys.length > 0) {
      const n = await this.local.delete(localKeys);
      removed += typeof n === "number" ? n : n ? localKeys.length : 0;
    }
    return Array.isArray(key) ? removed : removed > 0;
  }

  /**
   * Only ever called by the provider on transient `code_verifier` prefixes,
   * which live in DO storage — delegate straight through. (Credential keys are
   * never enumerated.)
   */
  async list<T = unknown>(options?: ListOptions): Promise<Map<string, T>> {
    return this.local.list<T>(options);
  }
}
