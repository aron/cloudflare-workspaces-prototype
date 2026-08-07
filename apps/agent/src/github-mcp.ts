/**
 * GitHub MCP integration — per-user OAuth over a single connection.
 *
 * Mirrors the Cloudflare MCP integration (`cloudflare-mcp.ts`) so the two feel
 * identical to the model and the UI: one MCP connection per user, tokens stored
 * per-user in KV, an interactive OAuth card, and per-turn tool gating so B can't
 * act through A's GitHub account.
 *
 * One material difference drives this being its own module rather than a config
 * tweak on the Cloudflare path:
 *
 *   **GitHub's remote MCP server does NOT support OAuth Dynamic Client
 *   Registration (DCR).** The Cloudflare server does, so the stock
 *   `DurableObjectOAuthClientProvider` can register itself just-in-time. GitHub
 *   instead requires a *pre-registered GitHub OAuth App* — a fixed client_id +
 *   client_secret. The MCP SDK's `auth()` skips DCR entirely when the provider's
 *   `clientInformation()` already returns client info, so `HackspaceOAuthProvider`
 *   below pre-seeds GitHub's static credentials (and uses `client_secret_post`
 *   token auth) while leaving the Cloudflare path on pure DCR.
 *
 * Scope of access — "read and maintain, but not push code":
 *   The hard "no code push" guarantee is enforced at the MCP server via the
 *   read-only flag in `GITHUB_MCP` below (`X-MCP-Readonly: true`), which is
 *   validated by GitHub and can never expose a write/push tool. See the header
 *   comment on `GITHUB_MCP` for how to widen this to a maintenance allow-list
 *   (issue/PR triage) that still refuses code pushes.
 */
import { DurableObjectOAuthClientProvider, normalizeServerId } from "agents";
import {
  CLOUDFLARE_MCP_CLIENT_NAME,
  CLOUDFLARE_MCP_ID_PREFIX,
} from "./cloudflare-mcp.js";
import {
  SplitOAuthStorage,
  type DoStorageLike,
  type KvLike,
} from "./mcp-oauth-storage.js";

/** Prefix for the per-user GitHub MCP connection/server id. */
export const GITHUB_MCP_ID_PREFIX = "github-";

/**
 * The GitHub remote MCP server endpoint + transport headers.
 *
 * Default: the base ("default") toolset in **read-only** mode. `X-MCP-Readonly`
 * is enforced server-side by GitHub, so no tool that can push code, merge, or
 * otherwise write to a repository is ever exposed — this is the belt-and-braces
 * guarantee behind "read and maintain, but not push code". Read-only still
 * covers the bulk of "maintain" work: reading repos/files/commits/branches,
 * inspecting issues and pull requests, CI runs, security alerts, etc.
 *
 * To widen to *maintenance writes that still refuse code pushes* (triaging
 * issues, labelling, commenting on PRs) drop `X-MCP-Readonly` and pin an
 * explicit tool allow-list instead — GitHub rejects unknown tool names at
 * startup, so keep this list to names from the official server docs, e.g.:
 *
 *   headers: {
 *     "X-MCP-Tools":
 *       "get_file_contents,issue_read,pull_request_read,list_commits," +
 *       "create_issue,update_issue,add_issue_comment,add_sub_issue," +
 *       "create_pull_request,add_comment_to_pending_review",
 *   }
 *
 * Note there is deliberately no `create_or_update_file`, `push_files`,
 * `merge_pull_request`, or `delete_file` in that list — those push code.
 * Do NOT enable the write-capable `repos` toolset wholesale: it bundles the
 * code-push tools. Only a tool allow-list can express "issues write + repos
 * read" cleanly.
 */
export const GITHUB_MCP: { url: string; headers: Record<string, string> } = {
  url: "https://api.githubcopilot.com/mcp/",
  headers: { "X-MCP-Readonly": "true" },
};

/**
 * OAuth scopes requested from the user's GitHub account.
 *
 * `repo` is required to read *private* repositories (classic OAuth Apps have no
 * private-read-only scope). The token nominally carries write capability, but it
 * is only ever used through the read-only MCP server above, which never exposes
 * a write tool — so the agent cannot push code even though the token could in
 * principle. `read:org`/`read:user` cover org and profile reads for maintenance.
 */
export const GITHUB_MCP_SCOPE = "repo read:org read:user";

/**
 * Per-user MCP server id. One connection per user so each authorizes their own
 * GitHub account and the framework stores/restores each independently. The id
 * also namespaces the tool names, so `beforeTurn` can gate a turn to just the
 * current user's GitHub tools.
 */
export function githubServerId(userId: string): string {
  return `${GITHUB_MCP_ID_PREFIX}${userId}`;
}

/** Recover the (pre-normalization) user id from a GitHub server id. */
export function userIdFromGithubServerId(serverId: string): string {
  return serverId.startsWith(GITHUB_MCP_ID_PREFIX)
    ? serverId.slice(GITHUB_MCP_ID_PREFIX.length)
    : serverId;
}

/**
 * The AI-SDK tool-name prefix the MCP layer uses for a given server id:
 * `tool_${normalizedIdWithoutDashes}_` (e.g. `tool_githubusera_`).
 */
export function githubToolPrefix(userId: string): string {
  const normalized = normalizeServerId(githubServerId(userId));
  return `tool_${normalized.replace(/-/g, "")}_`;
}

/**
 * Gate a turn's tool set to the current user's GitHub tools.
 *
 * Mirrors `gateCloudflareTools`: keep only the GitHub tools belonging to
 * whoever sent the last message, and drop every other user's, so B's turn can't
 * act through A's GitHub account. Non-GitHub tools always pass through, so this
 * composes with `gateCloudflareTools` (run either order).
 *
 * Returns the tool keys to KEEP. `currentUserId` of null drops all GitHub tools.
 */
export function gateGithubTools(
  allToolKeys: readonly string[],
  currentUserId: string | null,
): string[] {
  const keepPrefix = currentUserId ? githubToolPrefix(currentUserId) : null;
  const githubStem = "tool_github";
  return allToolKeys.filter((key) => {
    if (!key.startsWith(githubStem)) return true; // non-GitHub: keep
    return keepPrefix != null && key.startsWith(keepPrefix); // only current user
  });
}

/**
 * Static OAuth client information the GitHub path pre-seeds so the MCP SDK
 * skips Dynamic Client Registration (which GitHub does not support).
 */
interface StaticClientInfo {
  client_id: string;
  client_secret: string;
}

/**
 * A `DurableObjectOAuthClientProvider` that serves BOTH the Cloudflare
 * (DCR-based) and GitHub (static-app) MCP connections, dispatching on its own
 * `serverId` — which the framework assigns right after construction, including
 * on restore-on-wake. This single class is required because the framework's
 * `createMcpOAuthProvider(callbackUrl)` factory is called before the server id
 * is known, so the provider can't be specialised up front.
 *
 *   - Cloudflare server ids (`cloudflare-*`): behaves exactly like the stock
 *     provider — DCR registers the client, tokens/client-info route to KV via
 *     `SplitOAuthStorage`.
 *   - GitHub server ids (`github-*`): pre-seeds the static GitHub OAuth App
 *     credentials so `clientInformation()` is non-empty (skipping DCR) and the
 *     token exchange authenticates with `client_secret_post`.
 */
export class HackspaceOAuthProvider extends DurableObjectOAuthClientProvider {
  constructor(
    storage: DurableObjectStorage,
    clientName: string,
    baseRedirectUrl: string,
    private readonly github: StaticClientInfo | undefined,
  ) {
    super(storage, clientName, baseRedirectUrl);
  }

  /** Read the assigned server id without throwing when it is not set yet. */
  serverIdOrUndefined(): string | undefined {
    try {
      return this.serverId;
    } catch {
      return undefined;
    }
  }

  private isGithub(): boolean {
    return (
      this.github !== undefined &&
      (this.serverIdOrUndefined()?.startsWith(GITHUB_MCP_ID_PREFIX) ?? false)
    );
  }

  override get clientMetadata() {
    const base = super.clientMetadata;
    if (!this.isGithub()) return base;
    // GitHub is a confidential client (has a secret) and does not support DCR.
    // Advertise secret-based token auth and the scopes we need. NB: the MCP
    // SDK's token exchange selects the auth method from `clientInformation()`,
    // not from here (clientMetadata only feeds DCR, which GitHub skips), so the
    // authoritative `token_endpoint_auth_method` is also set there.
    return {
      ...base,
      token_endpoint_auth_method: "client_secret_post",
      scope: GITHUB_MCP_SCOPE,
    };
  }

  override get clientId(): string {
    if (this.isGithub() && this.github) return this.github.client_id;
    return super.clientId;
  }

  override set clientId(value: string) {
    // Defer to the base setter (writes the private backing field) so the
    // Cloudflare/DCR path keeps working. The GitHub getter ignores this and
    // always returns the static id.
    super.clientId = value;
  }

  override async clientInformation() {
    if (this.isGithub() && this.github) {
      // Non-empty → MCP SDK's auth() skips Dynamic Client Registration. The SDK
      // reads `token_endpoint_auth_method` from THIS object (not clientMetadata)
      // to pick how it authenticates the token exchange, so set it here to send
      // the secret in the request body (client_secret_post).
      return {
        client_id: this.github.client_id,
        client_secret: this.github.client_secret,
        token_endpoint_auth_method: "client_secret_post",
      };
    }
    return super.clientInformation();
  }
}

/**
 * Build a unified OAuth provider bound to one user's KV token partition,
 * serving both the Cloudflare (DCR) and GitHub (static-app) connections.
 *
 * Credentials/tokens route to KV (keyed by user id, prefix-stripped for either
 * provider) and transient flow state to DO-local storage, via `SplitOAuthStorage`
 * — identical to the Cloudflare-only provider, extended to recognise GitHub ids.
 *
 * `github` is undefined when the GitHub OAuth App is not configured on the
 * deployment; the provider then behaves exactly like the Cloudflare-only one.
 */
export function createHackspaceOAuthProvider(opts: {
  kv: KvLike;
  local: DoStorageLike;
  callbackUrl: string;
  github?: StaticClientInfo;
}): HackspaceOAuthProvider {
  // Chicken-and-egg (same as the Cloudflare provider): storage needs the user
  // id, encoded in the provider's serverId, which the framework assigns *after*
  // construction. Resolve it lazily through a holder.
  const holder: { provider?: HackspaceOAuthProvider } = {};
  const storage = new SplitOAuthStorage(opts.kv, opts.local, () => {
    const id = holder.provider?.serverIdOrUndefined();
    if (!id) return "unknown";
    if (id.startsWith(GITHUB_MCP_ID_PREFIX)) return userIdFromGithubServerId(id);
    if (id.startsWith(CLOUDFLARE_MCP_ID_PREFIX)) {
      return id.slice(CLOUDFLARE_MCP_ID_PREFIX.length);
    }
    return id;
  });
  // Both connections share one KV client-name namespace; the per-server key
  // segment (serverId) keeps their tokens partitioned. We keep the Cloudflare
  // client name as the shared prefix so existing Cloudflare tokens are unaffected.
  const provider = new HackspaceOAuthProvider(
    storage as unknown as DurableObjectStorage,
    CLOUDFLARE_MCP_CLIENT_NAME,
    opts.callbackUrl,
    opts.github,
  );
  holder.provider = provider;
  return provider;
}
