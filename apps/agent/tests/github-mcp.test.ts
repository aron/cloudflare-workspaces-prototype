/**
 * Unit tests for the pure GitHub-MCP helpers: server-id <-> user-id mapping and
 * per-turn tool gating. Mirrors `cloudflare-mcp.test.ts`; the connection-status
 * and poll helpers are shared with the Cloudflare module and covered there.
 */
import { describe, it, expect } from "vitest";
import {
  GITHUB_MCP,
  GITHUB_MCP_SCOPE,
  HackspaceOAuthProvider,
  createHackspaceOAuthProvider,
  gateGithubTools,
  githubServerId,
  githubToolPrefix,
  userIdFromGithubServerId,
} from "../src/github-mcp.js";
import { cloudflareToolPrefix } from "../src/cloudflare-mcp.js";

/** Minimal DurableObjectStorage-shaped stub (the provider only touches it on
 *  paths these tests don't exercise; a truthy object satisfies the ctor). */
function stubDoStorage() {
  const map = new Map<string, unknown>();
  return {
    map,
    get: async (k: string) => map.get(k),
    put: async (k: string, v: unknown) => void map.set(k, v),
    delete: async (k: string | string[]) => {
      const keys = Array.isArray(k) ? k : [k];
      let n = 0;
      for (const key of keys) if (map.delete(key)) n++;
      return Array.isArray(k) ? n : n > 0;
    },
    list: async () => new Map(),
  };
}

/** Minimal KVNamespace-shaped stub matching the `KvLike` surface. */
function stubKv() {
  const map = new Map<string, string>();
  return {
    map,
    get: async (k: string, _type: "json") => {
      const v = map.get(k);
      return v == null ? null : JSON.parse(v);
    },
    put: async (k: string, v: string) => void map.set(k, v),
    delete: async (k: string) => void map.delete(k),
  };
}

describe("github server id <-> user id", () => {
  it("round-trips a user id through the server id", () => {
    expect(githubServerId("user-A")).toBe("github-user-A");
    expect(userIdFromGithubServerId("github-user-A")).toBe("user-A");
  });
  it("returns the input unchanged when it lacks the prefix", () => {
    expect(userIdFromGithubServerId("something-else")).toBe("something-else");
  });
});

describe("gateGithubTools", () => {
  it("keeps only the current user's GitHub tools, plus all non-GitHub", () => {
    const prefixA = githubToolPrefix("usera");
    const prefixB = githubToolPrefix("userb");
    const keys = [
      "read",
      "exec",
      "github",
      `${prefixA}get_file_contents`,
      `${prefixA}issue_read`,
      `${prefixB}get_file_contents`,
    ];
    const kept = gateGithubTools(keys, "usera");
    expect(kept).toContain("read");
    expect(kept).toContain("exec");
    expect(kept).toContain("github");
    expect(kept).toContain(`${prefixA}get_file_contents`);
    expect(kept).toContain(`${prefixA}issue_read`);
    // B's GitHub tool is dropped from A's turn.
    expect(kept).not.toContain(`${prefixB}get_file_contents`);
  });

  it("drops all GitHub tools when there is no identified user", () => {
    const prefixA = githubToolPrefix("usera");
    const keys = ["read", `${prefixA}issue_read`];
    expect(gateGithubTools(keys, null)).toEqual(["read"]);
  });

  it("passes Cloudflare tools through untouched (gates compose)", () => {
    // gateGithubTools must not disturb Cloudflare tools, so the two gate
    // functions can be applied in sequence in beforeTurn.
    const cf = cloudflareToolPrefix("userb");
    const keys = ["read", `${cf}search`, `${githubToolPrefix("usera")}issue_read`];
    const kept = gateGithubTools(keys, "usera");
    expect(kept).toContain(`${cf}search`); // untouched — that's Cloudflare's job
    expect(kept).toContain(`${githubToolPrefix("usera")}issue_read`);
  });
});

describe("GITHUB_MCP endpoint config", () => {
  it("targets the official remote GitHub MCP server", () => {
    expect(GITHUB_MCP.url).toBe("https://api.githubcopilot.com/mcp/");
  });
  it("pins read-only so no code-push tool can ever be exposed", () => {
    // This is the hard "read and maintain, but not push code" guarantee.
    expect(GITHUB_MCP.headers["X-MCP-Readonly"]).toBe("true");
  });
});

describe("HackspaceOAuthProvider dispatch", () => {
  const gh = { client_id: "Iv1.abc", client_secret: "s3cr3t" };
  const make = (github: typeof gh | undefined) =>
    new HackspaceOAuthProvider(
      stubDoStorage() as never,
      "hackspace-cloudflare",
      "https://app.example/cb",
      github,
    );

  it("serves the static GitHub creds (and skips DCR) for github-* ids", async () => {
    const p = make(gh);
    p.serverId = "github-alice";
    // Static id surfaces via the getter, so tokenKey/clientInfoKey resolve
    // without the framework ever assigning a DCR-registered id.
    expect(p.clientId).toBe("Iv1.abc");
    // Non-empty clientInformation() is what makes the MCP SDK skip DCR, and it
    // must carry the auth method the token exchange reads from here.
    expect(await p.clientInformation()).toMatchObject({
      client_id: "Iv1.abc",
      client_secret: "s3cr3t",
      token_endpoint_auth_method: "client_secret_post",
    });
    expect(p.clientMetadata.token_endpoint_auth_method).toBe("client_secret_post");
    expect(p.clientMetadata.scope).toBe(GITHUB_MCP_SCOPE);
  });

  it("keeps the stock DCR behavior for cloudflare-* ids", async () => {
    const p = make(gh);
    p.serverId = "cloudflare-alice";
    // No static creds leak onto Cloudflare: clientInformation is empty until
    // DCR registers a client (which is exactly how the Cloudflare path works).
    expect(await p.clientInformation()).toBeUndefined();
    // The setter override must still write the DCR-assigned id through to the
    // base backing field (a getter-only override would silently drop it).
    p.clientId = "cf-dynamic-id";
    expect(p.clientId).toBe("cf-dynamic-id");
    // Metadata stays on the stock public-client shape, not GitHub's.
    expect(p.clientMetadata.token_endpoint_auth_method).not.toBe(
      "client_secret_post",
    );
    expect(p.clientMetadata.scope).toBeUndefined();
  });

  it("never synthesizes creds when GitHub is unconfigured, even for github-* ids", async () => {
    const p = make(undefined);
    p.serverId = "github-alice";
    expect(await p.clientInformation()).toBeUndefined();
    expect(p.clientMetadata.token_endpoint_auth_method).not.toBe(
      "client_secret_post",
    );
  });

  it("reports serverIdOrUndefined() without throwing before assignment", () => {
    expect(make(gh).serverIdOrUndefined()).toBeUndefined();
  });
});

describe("createHackspaceOAuthProvider KV partitioning", () => {
  const gh = { client_id: "Iv1.abc", client_secret: "sec" };
  const token = { access_token: "x", token_type: "bearer" };

  it("routes GitHub and Cloudflare tokens to distinct per-user KV rows", async () => {
    // One shared KV namespace, as in production.
    const kv = stubKv();

    const ghP = createHackspaceOAuthProvider({
      kv: kv as never,
      local: stubDoStorage() as never,
      callbackUrl: "https://app.example/cb",
      github: gh,
    });
    ghP.serverId = "github-alice";
    await ghP.saveTokens({ ...token, access_token: "gh-token" } as never);

    const cfP = createHackspaceOAuthProvider({
      kv: kv as never,
      local: stubDoStorage() as never,
      callbackUrl: "https://app.example/cb",
      github: gh,
    });
    cfP.serverId = "cloudflare-alice";
    cfP.clientId = "cf-dyn"; // DCR-assigned id for the Cloudflare path
    await cfP.saveTokens({ ...token, access_token: "cf-token" } as never);

    const keys = [...kv.map.keys()];
    const ghKey = keys.find((k) => k.includes("/github-alice/"));
    const cfKey = keys.find((k) => k.includes("/cloudflare-alice/"));
    expect(ghKey).toBeDefined();
    expect(cfKey).toBeDefined();
    // Both partition under the same user id (authorize once per provider)...
    expect(ghKey).toContain("u/alice/");
    expect(cfKey).toContain("u/alice/");
    // ...but never collide across providers.
    expect(ghKey).not.toBe(cfKey);
    expect(JSON.parse(kv.map.get(ghKey!)!).access_token).toBe("gh-token");
    expect(JSON.parse(kv.map.get(cfKey!)!).access_token).toBe("cf-token");
  });

  it("partitions the same provider's tokens by user id", async () => {
    const kv = stubKv();
    for (const user of ["alice", "bob"]) {
      const p = createHackspaceOAuthProvider({
        kv: kv as never,
        local: stubDoStorage() as never,
        callbackUrl: "https://app.example/cb",
        github: gh,
      });
      p.serverId = githubServerId(user);
      await p.saveTokens({ ...token, access_token: `${user}-token` } as never);
    }
    const keys = [...kv.map.keys()];
    expect(keys.some((k) => k.includes("u/alice/"))).toBe(true);
    expect(keys.some((k) => k.includes("u/bob/"))).toBe(true);
    // A's row can't be read under B's partition.
    const aliceKey = keys.find((k) => k.includes("u/alice/"))!;
    expect(aliceKey).not.toContain("u/bob/");
  });
});
