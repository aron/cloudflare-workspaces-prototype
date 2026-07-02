/**
 * Cloudflare MCP integration — per-user OAuth over a single connection.
 *
 * The Cloudflare API MCP server (`https://mcp.cloudflare.com/mcp`) is itself a
 * Code Mode server: it exposes just `search`/`execute` (~1k tokens) covering the
 * entire Cloudflare API, and Think auto-merges those tools into every turn once
 * the connection is READY. So we don't wrap it in our own codemode — we connect
 * as an OAuth client and let each user authorize their own Cloudflare account.
 *
 * Design:
 *   - **One** MCP connection (server id `cloudflare`). Tools are stably named
 *     `tool_cloudflare_search` / `tool_cloudflare_execute`.
 *   - **Per-user tokens in KV**, keyed by the requesting user's id (see
 *     `mcp-oauth-storage.ts`). The OAuth provider reads/writes tokens through a
 *     `SplitOAuthStorage`, so a user authorizes once and every thread reuses it.
 *   - **Whose token?** The author of the *last* user message. When the active
 *     user changes between turns we reconnect with that user's provider (the
 *     OAuth session is identity-bound on the server, so a live connection can't
 *     just swap tokens — it must reconnect).
 *   - **Expiry**: the SDK auto-refreshes on a 401 and calls `saveTokens`, which
 *     routes back to KV — so refreshed tokens persist with no extra code. When
 *     the refresh token itself is dead, the connection returns to AUTHENTICATING
 *     and we re-surface the auth link to the user.
 */
import { DurableObjectOAuthClientProvider, normalizeServerId } from "agents";
import type { SessionMessage } from "agents/experimental/memory/session";
import {
  SplitOAuthStorage,
  type DoStorageLike,
  type KvLike,
} from "./mcp-oauth-storage.js";

/** Prefix for the per-user Cloudflare MCP connection/server id. */
export const CLOUDFLARE_MCP_ID_PREFIX = "cloudflare-";

/** The Cloudflare API MCP server (Code Mode: search + execute). */
export const CLOUDFLARE_MCP_URL = "https://mcp.cloudflare.com/mcp";

/** OAuth client name — namespaces stored client registration/tokens. */
export const CLOUDFLARE_MCP_CLIENT_NAME = "hackspace-cloudflare";

/**
 * Per-user MCP server id. One connection per user so each authorizes their own
 * Cloudflare account and the framework stores/restores each independently. The
 * id is also what the tool names are namespaced by
 * (`tool_cloudflare<userId>_search`), so `beforeTurn` can gate a turn to just
 * the current user's Cloudflare tools.
 *
 * `normalizeServerId` in the framework lowercases and strips non-alphanumerics,
 * so we pre-sanitize the user id to keep the mapping stable and reversible-ish
 * for our own bookkeeping.
 */
export function cloudflareServerId(userId: string): string {
  return `${CLOUDFLARE_MCP_ID_PREFIX}${userId}`;
}

/** Recover the (pre-normalization) user id from a Cloudflare server id. */
export function userIdFromServerId(serverId: string): string {
  return serverId.startsWith(CLOUDFLARE_MCP_ID_PREFIX)
    ? serverId.slice(CLOUDFLARE_MCP_ID_PREFIX.length)
    : serverId;
}

/**
 * The AI-SDK tool-name prefix the MCP layer uses for a given server id:
 * `tool_${normalizedIdWithoutDashes}_`. Tools for that server are
 * `${prefix}${toolName}` (e.g. `tool_cloudflareusera_search`).
 */
export function cloudflareToolPrefix(userId: string): string {
  const normalized = normalizeServerId(cloudflareServerId(userId));
  return `tool_${normalized.replace(/-/g, "")}_`;
}

/**
 * Gate a turn's tool set to the current user's Cloudflare tools.
 *
 * Because each user has their own per-user Cloudflare MCP connection, *every*
 * authorized user's `search`/`execute` tools are auto-merged into the turn. We
 * must keep only the tools belonging to whoever sent the last message, and drop
 * every other user's Cloudflare tools, so B's turn can't act through A's
 * Cloudflare account. Non-Cloudflare tools always pass through.
 *
 * Returns the tool keys to KEEP. `currentUserId` of null (no identified user)
 * drops all Cloudflare tools.
 */
export function gateCloudflareTools(
  allToolKeys: readonly string[],
  currentUserId: string | null,
): string[] {
  const keepPrefix = currentUserId ? cloudflareToolPrefix(currentUserId) : null;
  // Any Cloudflare MCP tool key starts with `tool_cloudflare` (post-normalize,
  // the prefix always begins with the literal server-name stem).
  const cloudflareStem = "tool_cloudflare";
  return allToolKeys.filter((key) => {
    if (!key.startsWith(cloudflareStem)) return true; // non-Cloudflare: keep
    return keepPrefix != null && key.startsWith(keepPrefix); // only current user
  });
}

/**
 * Resolve the user id of the most recent `role: "user"` message — i.e. whoever
 * triggered the work we're about to do. Returns null when no user message
 * carries an author id (e.g. a freshly-seeded thread, or legacy messages).
 *
 * Mirrors `originatorFromMessages()` but scans newest-first, because the token
 * we use should belong to whoever last spoke, not the thread originator.
 */
export function lastUserAuthorId(
  messages: readonly SessionMessage[],
): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    const meta = (m as { metadata?: { author?: { kind?: string; id?: string } } })
      .metadata;
    const a = meta?.author;
    if (a && a.kind === "user" && typeof a.id === "string" && a.id) {
      return a.id;
    }
  }
  return null;
}

/** Connection status the `cloudflare` tool reports back to the model. */
export type CloudflareConnStatus =
  | { state: "disconnected" }
  | { state: "authenticating"; authUrl: string | null }
  | { state: "ready" }
  | { state: "failed"; error: string | null }
  | { state: "connecting" };

/** Minimal shape of a `getMcpServers().servers[id]` entry we read. */
export interface McpServerView {
  state: string;
  auth_url: string | null;
  error: string | null;
}

/**
 * Render the Cloudflare connection's status from the MCP servers snapshot.
 * Pure so the tool's status branch is unit-testable without a live DO.
 */
export function describeConnection(
  server: McpServerView | undefined,
): CloudflareConnStatus {
  if (!server) return { state: "disconnected" };
  switch (server.state) {
    case "authenticating":
      return { state: "authenticating", authUrl: server.auth_url };
    case "ready":
      return { state: "ready" };
    case "failed":
      return { state: "failed", error: server.error };
    default:
      return { state: "connecting" };
  }
}

/**
 * Build a Cloudflare OAuth provider bound to one user's KV token partition.
 *
 * The provider is a stock `DurableObjectOAuthClientProvider` — all its
 * token/client-info/state reads and writes flow through the injected
 * `SplitOAuthStorage`, which routes credentials to KV (keyed by `userId`) and
 * transient flow state to DO-local storage. Because `saveTokens` also routes to
 * KV, the SDK's automatic refresh-on-401 persists the refreshed token for free.
 *
 * `callbackUrl` is the OAuth redirect URL the framework computes for this agent
 * instance; the provider hands it to the authorization server.
 */
export function createCloudflareOAuthProvider(opts: {
  kv: KvLike;
  local: DoStorageLike;
  callbackUrl: string;
}): DurableObjectOAuthClientProvider {
  // Chicken-and-egg: the storage needs the user id, which is encoded in the
  // provider's `serverId` — but that is set by the framework *after*
  // construction. Resolve it lazily through a holder so restore-on-wake (which
  // rebuilds the provider then assigns serverId) keys KV under the right user.
  const holder: { provider?: DurableObjectOAuthClientProvider } = {};
  const storage = new SplitOAuthStorage(opts.kv, opts.local, () =>
    holder.provider ? userIdFromServerId(holder.provider.serverId) : "unknown",
  );
  const provider = new DurableObjectOAuthClientProvider(
    // The adapter implements the subset of DurableObjectStorage the provider
    // uses; cast through unknown to satisfy the constructor's nominal type.
    storage as unknown as DurableObjectStorage,
    CLOUDFLARE_MCP_CLIENT_NAME,
    opts.callbackUrl,
  );
  holder.provider = provider;
  return provider;
}
