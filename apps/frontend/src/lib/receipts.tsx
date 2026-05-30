/**
 * Read receipts + activity tips, exposed via React context.
 *
 * Responsibilities:
 *   - Bootstraps a snapshot from `GET /api/app/me/receipts` once on mount.
 *   - Opens the App WebSocket (`/api/app/ws`) and applies `tip` / `receipt`
 *     frames so unread badges stay live across tabs and users.
 *   - Sends `focus` / `blur` presence frames based on the current route and
 *     `document.visibilityState`. The server uses presence to auto-advance
 *     receipts when a message lands on a scope the user is actively viewing.
 *   - Exposes `markRead(scope, id, ts)` which does an optimistic local
 *     update and a debounced, monotonic PUT to the server.
 *
 * All state is per-tab. The server is the source of truth; this context is
 * a denormalised cache wired up to the live socket.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { ReceiptScope, ReadReceipt, ActivityTip } from "@app/shared";
import { fetchReceipts, openAppSocket, putReceipt } from "./api";
import { navigate, useRoute } from "./nav";
import type { Route } from "./route";
import { ReceiptsBuffer } from "./receipts-buffer";

// ---- internal state ----

type Key = `${ReceiptScope}:${string}`;
const k = (scope: ReceiptScope, scopeId: string): Key => `${scope}:${scopeId}`;

// ---- in-page mention notifications ----

/**
 * Shape of the `mention` frame the App DO emits during the drain pass for
 * users opted into in-page browser notifications.
 */
interface MentionFrame {
  type:        "mention";
  roomId:      string;
  threadId?:   string;
  messageId:   string;
  roomName:    string;
  authorName:  string;
  snippet:     string;
  count:       number;
  createdAt:   number;
  roomUrl?:    string;
}

/**
 * Render a Notification for an inbound mention frame. Three suppression
 * rules apply:
 *   1. Permission must be "granted". We don't auto-prompt here — the
 *      settings dialog owns that flow.
 *   2. Skip when the current route already points at this mention's scope
 *      *and* the document is visible. The user is looking at the message;
 *      no point pinging.
 *   3. The Notification API itself is unavailable (older browsers, SSR).
 *
 * `tag: messageId` collapses duplicates across multiple tabs of the same
 * window/session — only one notification surfaces per mention.
 */
function showMentionNotification(frame: MentionFrame, route: Route): void {
  if (typeof Notification === "undefined") return;
  if (Notification.permission !== "granted") return;

  const onSameScope =
    (route.kind === "thread" && frame.threadId && route.threadId === frame.threadId) ||
    (route.kind === "room"   && !frame.threadId && route.roomId   === frame.roomId);
  const visible = typeof document !== "undefined" && document.visibilityState === "visible";
  if (onSameScope && visible) return;

  const title = frame.count > 1
    ? `${frame.authorName} — ${frame.count} new mentions in ${frame.roomName}`
    : `${frame.authorName} mentioned you in ${frame.roomName}`;
  const notification = new Notification(title, {
    body: frame.snippet,
    tag:  frame.messageId,
    data: { roomId: frame.roomId, threadId: frame.threadId },
  });
  notification.onclick = () => {
    window.focus();
    if (frame.threadId) {
      navigate({ kind: "thread", roomId: frame.roomId, threadId: frame.threadId });
    } else {
      navigate({ kind: "room", roomId: frame.roomId });
    }
    notification.close();
  };
}

interface ReceiptsState {
  /** `lastRead` per scope, for the signed-in user. */
  receipts: ReadonlyMap<Key, number>;
  /** `lastActivity` per scope, server-tracked across all users. */
  tips:     ReadonlyMap<Key, number>;
  /** Whether the initial snapshot has loaded. */
  ready:    boolean;
}

interface ReceiptsApi extends ReceiptsState {
  /**
   * Advance the read marker for `(scope, scopeId)` to `lastRead`. Monotonic:
   * a stale timestamp is a no-op locally and on the server. Debounced so
   * rapid-fire calls (e.g. one per incoming WS frame) collapse into a single
   * PUT per scope.
   */
  markRead(scope: ReceiptScope, scopeId: string, lastRead: number): void;
  /** True when `tip > receipt` for this scope. False before the snapshot loads. */
  isUnread(scope: ReceiptScope, scopeId: string): boolean;
}

const ReceiptsContext = createContext<ReceiptsApi | null>(null);

// ---- provider ----

const PING_INTERVAL_MS = 30_000;
const MARK_READ_DEBOUNCE_MS = 400;
const RECONNECT_BACKOFF_MS = [500, 1_000, 2_000, 5_000, 10_000] as const;

interface ProviderProps {
  /** Signed-in user id. Used to filter inbound `receipt` frames. */
  userId:   string;
  children: React.ReactNode;
}

export function ReceiptsProvider({ userId, children }: ProviderProps): React.ReactElement {
  const route = useRoute();
  // Mirror the current route into a ref so the WS frame handler (which is
  // closed over the initial route) can read the latest value without us
  // tearing down and rebuilding the socket on every navigation.
  const routeRef = useRef(route);
  routeRef.current = route;
  const [receipts, setReceipts] = useState<Map<Key, number>>(() => new Map());
  const [tips,     setTips]     = useState<Map<Key, number>>(() => new Map());
  const [ready,    setReady]    = useState(false);

  // The live socket and the most recently *sent* focus frame are tracked in
  // refs: they're orthogonal to render, and we want effect cleanup to see
  // the current value (not a stale closure).
  const wsRef       = useRef<WebSocket | null>(null);
  const sentFocus   = useRef<Key | null>(null);
  // Debounced + monotonic PUT pipeline. The pure logic lives in
  // `receipts-buffer` so it can be unit-tested without a renderer.
  const bufferRef = useRef<ReceiptsBuffer | null>(null);
  if (!bufferRef.current) {
    bufferRef.current = new ReceiptsBuffer({
      debounceMs: MARK_READ_DEBOUNCE_MS,
      emit:    (scope, scopeId, lastRead) => putReceipt(scope, scopeId, lastRead),
      onError: (err) => console.warn("[receipts] PUT failed", err),
    });
  }

  // Cancel any pending PUTs when the provider unmounts. We don't flush:
  // the server is the source of truth, and another tab / the next mount
  // will catch up via the snapshot fetch.
  useEffect(() => () => { bufferRef.current?.cancel(); }, []);

  // ---- bootstrap snapshot ----

  useEffect(() => {
    let cancelled = false;
    fetchReceipts().then(snap => {
      if (cancelled) return;
      setReceipts(new Map(snap.receipts.map(r => [k(r.scope, r.scopeId), r.lastRead])));
      setTips(    new Map(snap.tips.map(    t => [k(t.scope, t.scopeId), t.lastActivity])));
      setReady(true);
    }).catch(err => {
      console.warn("[receipts] snapshot failed", err);
      setReady(true);  // Don't block the UI; live frames will fill us in.
    });
    return () => { cancelled = true; };
  }, []);

  // ---- WS lifecycle ----

  useEffect(() => {
    let attempt   = 0;
    let cancelled = false;
    let reconnect: ReturnType<typeof setTimeout> | null = null;
    let pingTimer: ReturnType<typeof setInterval> | null = null;

    const applyFrame = (raw: string) => {
      let frame: unknown;
      try { frame = JSON.parse(raw); } catch { return; }
      if (!frame || typeof frame !== "object") return;
      const f = frame as {
        type?: string;
        scope?: ReceiptScope;
        scopeId?: string;
        lastActivity?: number;
        lastRead?: number;
        userId?: string;
        // mention frame
        roomId?:    string;
        threadId?:  string;
        messageId?: string;
        roomName?:  string;
        authorName?: string;
        snippet?:    string;
        count?:      number;
      };
      if (f.type === "tip" && f.scope && f.scopeId && typeof f.lastActivity === "number") {
        const key = k(f.scope, f.scopeId);
        const next = f.lastActivity;
        setTips(prev => {
          const cur = prev.get(key) ?? 0;
          if (next <= cur) return prev;
          const out = new Map(prev);
          out.set(key, next);
          return out;
        });
        return;
      }
      if (f.type === "receipt" && f.userId === userId && f.scope && f.scopeId && typeof f.lastRead === "number") {
        const key = k(f.scope, f.scopeId);
        const next = f.lastRead;
        setReceipts(prev => {
          const cur = prev.get(key) ?? 0;
          if (next <= cur) return prev;
          const out = new Map(prev);
          out.set(key, next);
          return out;
        });
        return;
      }
      if (f.type === "mention" && f.roomId && f.messageId) {
        showMentionNotification(f as MentionFrame, routeRef.current);
        return;
      }
    };

    const connect = () => {
      if (cancelled) return;
      const ws = openAppSocket();
      wsRef.current = ws;
      ws.addEventListener("open", () => {
        attempt = 0;
        // Re-assert focus on reconnect so the server's in-memory presence
        // map (which is wiped on hibernation) catches back up.
        if (sentFocus.current) {
          const [scope, scopeId] = sentFocus.current.split(":") as [ReceiptScope, string];
          ws.send(JSON.stringify({ type: "focus", scope, scopeId }));
        }
        pingTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" }));
        }, PING_INTERVAL_MS);
      });
      ws.addEventListener("message", (e) => {
        if (typeof e.data === "string") applyFrame(e.data);
      });
      ws.addEventListener("close", () => {
        if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
        wsRef.current = null;
        if (cancelled) return;
        const delay = RECONNECT_BACKOFF_MS[Math.min(attempt, RECONNECT_BACKOFF_MS.length - 1)];
        attempt += 1;
        reconnect = setTimeout(connect, delay);
      });
      ws.addEventListener("error", () => {
        // `close` will fire next; let it drive the reconnect.
      });
    };

    connect();
    return () => {
      cancelled = true;
      if (reconnect) clearTimeout(reconnect);
      if (pingTimer) clearInterval(pingTimer);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [userId]);

  // ---- presence: send focus/blur on route + visibility changes ----

  useEffect(() => {
    // Resolve the route into a focus target. Picker → blur.
    const target: { scope: ReceiptScope; scopeId: string } | null =
      route.kind === "thread" ? { scope: "thread", scopeId: route.threadId }
      : route.kind === "room" ? { scope: "room",   scopeId: route.roomId }
      : null;

    const sendFocus = () => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
      if (!target || hidden) {
        if (sentFocus.current !== null) {
          ws.send(JSON.stringify({ type: "blur" }));
          sentFocus.current = null;
        }
        return;
      }
      const next = k(target.scope, target.scopeId);
      if (sentFocus.current === next) return;
      ws.send(JSON.stringify({ type: "focus", scope: target.scope, scopeId: target.scopeId }));
      sentFocus.current = next;
    };

    // Send immediately + on the next WS open (sendFocus is idempotent).
    sendFocus();
    const onVis  = () => sendFocus();
    const onOpen = () => sendFocus();
    document.addEventListener("visibilitychange", onVis);
    // The current socket may be opening; re-emit when it opens.
    wsRef.current?.addEventListener("open", onOpen);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      wsRef.current?.removeEventListener("open", onOpen);
    };
  }, [route.kind, "roomId" in route ? route.roomId : "", "threadId" in route ? route.threadId : ""]);

  // ---- markRead ----

  const markRead = useCallback((scope: ReceiptScope, scopeId: string, lastRead: number) => {
    if (!Number.isFinite(lastRead) || lastRead <= 0) return;
    const key = k(scope, scopeId);
    // Optimistic local update — render reflects the new state immediately.
    setReceipts(prev => {
      const cur = prev.get(key) ?? 0;
      if (lastRead <= cur) return prev;
      const out = new Map(prev);
      out.set(key, lastRead);
      return out;
    });
    // Debounced + monotonic PUT, all the tricky bits in ReceiptsBuffer.
    bufferRef.current?.push(scope, scopeId, lastRead);
  }, []);

  // ---- selectors ----

  const isUnread = useCallback((scope: ReceiptScope, scopeId: string): boolean => {
    if (!ready) return false;
    const key = k(scope, scopeId);
    const tip = tips.get(key) ?? 0;
    const rcp = receipts.get(key) ?? 0;
    return tip > rcp;
  }, [ready, tips, receipts]);

  const value = useMemo<ReceiptsApi>(() => ({
    receipts, tips, ready, markRead, isUnread,
  }), [receipts, tips, ready, markRead, isUnread]);

  return <ReceiptsContext.Provider value={value}>{children}</ReceiptsContext.Provider>;
}

// ---- hook ----

/**
 * Access the receipts state. Returns a no-op stub when used outside the
 * provider so components can be rendered standalone in tests / storybook
 * without a hard crash.
 */
export function useReceipts(): ReceiptsApi {
  const ctx = useContext(ReceiptsContext);
  if (ctx) return ctx;
  const empty = new Map<Key, number>();
  return {
    receipts: empty,
    tips:     empty,
    ready:    false,
    markRead: () => { /* no-op outside provider */ },
    isUnread: () => false,
  };
}
