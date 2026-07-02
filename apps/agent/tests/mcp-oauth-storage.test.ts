/**
 * Unit tests for the split OAuth storage adapter.
 *
 * Verifies the routing contract: credential keys (tokens, client info) go to
 * KV namespaced per user; transient flow-state keys (state, code_verifier) go
 * to DO-local storage. This is the core of "store tokens in KV so any thread
 * can read them, keep the OAuth handshake consistent in the Agent DO."
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  SplitOAuthStorage,
  isCredentialKey,
  type KvLike,
  type DoStorageLike,
} from "../src/mcp-oauth-storage.js";

class FakeKv implements KvLike {
  store = new Map<string, string>();
  async get(key: string, _type: "json"): Promise<unknown> {
    const raw = this.store.get(key);
    return raw === undefined ? null : JSON.parse(raw);
  }
  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

class FakeDo implements DoStorageLike {
  store = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    return this.store.has(key) ? (this.store.get(key) as T) : undefined;
  }
  async put<T>(key: string, value: T): Promise<void> {
    this.store.set(key, value);
  }
  async delete(key: string | string[]): Promise<boolean | number> {
    const keys = Array.isArray(key) ? key : [key];
    let n = 0;
    for (const k of keys) if (this.store.delete(k)) n++;
    return Array.isArray(key) ? n : n > 0;
  }
  async list<T>(options?: { prefix?: string }): Promise<Map<string, T>> {
    const out = new Map<string, T>();
    for (const [k, v] of this.store) {
      if (!options?.prefix || k.startsWith(options.prefix)) out.set(k, v as T);
    }
    return out;
  }
}

const TOKEN_KEY = "/cloudflare/cloudflare/client123/token";
const CLIENT_INFO_KEY = "/cloudflare/cloudflare/client123/client_info/";
const STATE_KEY = "/cloudflare/cloudflare/state/nonce123";
const VERIFIER_KEY =
  "/cloudflare/cloudflare/client123/code_verifier/nonce123";

describe("isCredentialKey", () => {
  it("classifies token and client_info keys as credentials", () => {
    expect(isCredentialKey(TOKEN_KEY)).toBe(true);
    expect(isCredentialKey(CLIENT_INFO_KEY)).toBe(true);
  });
  it("classifies state and code_verifier keys as transient", () => {
    expect(isCredentialKey(STATE_KEY)).toBe(false);
    expect(isCredentialKey(VERIFIER_KEY)).toBe(false);
  });
});

describe("SplitOAuthStorage", () => {
  let kv: FakeKv;
  let local: FakeDo;
  let storage: SplitOAuthStorage;

  beforeEach(() => {
    kv = new FakeKv();
    local = new FakeDo();
    storage = new SplitOAuthStorage(kv, local, "user-A");
  });

  it("routes tokens to KV, namespaced by userId", async () => {
    await storage.put(TOKEN_KEY, { access_token: "abc", refresh_token: "r" });
    // Landed in KV under the user prefix, not in DO storage.
    expect([...kv.store.keys()]).toEqual([`u/user-A/${TOKEN_KEY}`]);
    expect(local.store.size).toBe(0);
    // Round-trips back out.
    expect(await storage.get(TOKEN_KEY)).toEqual({
      access_token: "abc",
      refresh_token: "r",
    });
  });

  it("routes client info to KV", async () => {
    await storage.put(CLIENT_INFO_KEY, { client_id: "client123" });
    expect(kv.store.has(`u/user-A/${CLIENT_INFO_KEY}`)).toBe(true);
    expect(local.store.size).toBe(0);
  });

  it("routes transient state and verifier to DO-local storage", async () => {
    await storage.put(STATE_KEY, { nonce: "n" });
    await storage.put(VERIFIER_KEY, { codeVerifier: "v" });
    expect(kv.store.size).toBe(0);
    expect(local.store.has(STATE_KEY)).toBe(true);
    expect(local.store.has(VERIFIER_KEY)).toBe(true);
  });

  it("isolates tokens between users", async () => {
    await storage.put(TOKEN_KEY, { access_token: "A-token" });
    const storageB = new SplitOAuthStorage(kv, local, "user-B");
    await storageB.put(TOKEN_KEY, { access_token: "B-token" });

    expect(await storage.get(TOKEN_KEY)).toEqual({ access_token: "A-token" });
    expect(await storageB.get(TOKEN_KEY)).toEqual({ access_token: "B-token" });
  });

  it("deletes credential keys from KV and transient keys from DO storage", async () => {
    await storage.put(TOKEN_KEY, { access_token: "abc" });
    await storage.put(STATE_KEY, { nonce: "n" });

    await storage.delete([TOKEN_KEY, STATE_KEY]);
    expect(kv.store.size).toBe(0);
    expect(local.store.size).toBe(0);
  });

  it("delegates prefixed list() to DO storage (transient keys only)", async () => {
    await storage.put(VERIFIER_KEY, { codeVerifier: "v" });
    const prefix = "/cloudflare/cloudflare/client123/code_verifier/";
    const listed = await storage.list({ prefix });
    expect([...listed.keys()]).toEqual([VERIFIER_KEY]);
  });

  it("returns undefined for a missing token", async () => {
    expect(await storage.get(TOKEN_KEY)).toBeUndefined();
  });
});
