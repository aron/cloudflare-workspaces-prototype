/**
 * Centre pane: live timeline of a room's top-level messages plus the
 * composer that appends new ones.
 *
 * Subscribes to the room's WebSocket for live fanout from other users,
 * de-duplicates messages we appended optimistically, and auto-navigates
 * into the thread panel when a posted message returns a threadId.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Sparkles,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { MentionText } from "@/components/MentionText";
import { MentionTextarea } from "@/components/MentionTextarea";
import { serializeMentions } from "@/lib/mentions";
import { useHandleResolver } from "@/lib/useMentionCandidates";


import {
  deleteRoom,
  fetchRoomMeta,
  fetchRoomMessages,
  fetchThreadSummary,
  openRoomSocket,
  postRoomMessage,
} from "@/lib/api";
import * as outbox from "@/lib/roomOutbox";
import type { AppMessage, Me, RoomMeta } from "@/lib/api";
import { navigate } from "@/lib/nav";
import { useReceipts } from "@/lib/receipts";
import { initials, relTime } from "@/lib/utils";
import { isAtBottom, isMoreThanOneViewportFromBottom } from "@/lib/scroll-pinning";

const AVATAR_PALETTE = [
  "bg-[#ea7d3a]",
  "bg-[#3f8f7a]",
  "bg-[#a85f3d]",
  "bg-[#5a5a5a]",
  "bg-[#c89f5b]",
];

function authorIdx(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return h % AVATAR_PALETTE.length;
}

function authorName(msg: AppMessage): string {
  const a = msg.metadata.author;
  return a.kind === "user" ? a.name : a.name;
}

function authorKey(msg: AppMessage): string {
  const a = msg.metadata.author;
  return a.kind === "user" ? a.id : a.id;
}

export function RoomTimeline({
  me,
  roomId,
  activeThreadId,
  model,
}: {
  me:              Me;
  roomId:          string;
  activeThreadId?: string;
  /** Human-readable label for the current model. Display-only. */
  model:           string;
}) {
  const [meta,     setMeta]     = useState<RoomMeta | null>(null);
  const [messages, setMessages] = useState<AppMessage[]>([]);
  const [error,    setError]    = useState<string | null>(null);
  const [input,    setInput]    = useState("");
  const [sending,  setSending]  = useState(false);
  const resolveHandle = useHandleResolver();
  const { markRead } = useReceipts();

  // Scroll plumbing for the room timeline. Mirrors ThreadPanel: the
  // room loads pinned to the bottom (latest message visible), follows
  // new messages while pinned, and surfaces a floating jump-to-bottom
  // button once the user has scrolled back more than a viewport. Pure
  // threshold predicates live in `lib/scroll-pinning`.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [isPinned, setIsPinned] = useState(true);
  const [showJumpButton, setShowJumpButton] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting,      setDeleting]      = useState(false);

  const doDeleteRoom = useCallback(async () => {
    setDeleting(true);
    try {
      await deleteRoom(roomId);
      // RoomDO broadcasts room:deleted to other connected clients; for us,
      // bounce back to the picker so the now-empty room view doesn't 404.
      navigate({ kind: "picker" });
    } catch (e) {
      setError((e as Error).message);
      setConfirmDelete(false);
    } finally {
      setDeleting(false);
    }
  }, [roomId]);

  // Initial load.
  useEffect(() => {
    let cancelled = false;
    setMeta(null); setMessages([]); setError(null);
    (async () => {
      try {
        const [m, ms] = await Promise.all([
          fetchRoomMeta(roomId),
          fetchRoomMessages(roomId),
        ]);
        if (cancelled) return;
        setMeta(m);
        setMessages(ms);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => { cancelled = true; };
  }, [roomId]);

  // Mark the room read whenever we see new top-level (non-threaded) messages.
  // Covers all three trigger points in one place: initial load, live WS
  // fanout, and the user's own sends — they all funnel through `messages`.
  // Thread-starting messages bump the thread's tip, not the room's, so we
  // exclude them here.
  useEffect(() => {
    let max = 0;
    for (const m of messages) {
      if (m.metadata.threadId) continue;
      if (m.metadata.createdAt > max) max = m.metadata.createdAt;
    }
    if (max > 0) markRead("room", roomId, max);
  }, [messages, roomId, markRead]);

  // Pending outbox entries the flusher hasn't drained yet. We don't render
  // these directly (the optimistic message lives in `messages` keyed by
  // clientId), but holding the count in state lets the composer surface a
  // "queued" indicator when sends are sitting waiting for connectivity.
  const [pending, setPending] = useState<number>(() => outbox.list(roomId).length);

  // Stable handle for the WS so the flusher (a separate effect) can prod
  // the server when it sees we're online again. We don't need to read it,
  // we just need to know the socket is currently open.
  const wsOpenRef = useRef(false);

  const applyServerMessage = useCallback(
    (incoming: AppMessage, clientId?: string | null) => {
      setMessages(prev => {
        // Optimistic swap: if we have a pending message under this clientId,
        // replace it in place so the row doesn't jump or duplicate.
        if (clientId) {
          const idx = prev.findIndex(m => m.id === clientId);
          if (idx !== -1) {
            const next = prev.slice();
            next[idx] = incoming;
            return next;
          }
        }
        // No clientId match — this is either someone else's message or our
        // own coming back after we already swapped. Skip if the id is
        // already present.
        if (prev.some(m => m.id === incoming.id)) return prev;
        return [...prev, incoming];
      });
    },
    [],
  );

  // Live fanout via the RoomDO WebSocket. Reconnects with capped backoff.
  useEffect(() => {
    let closed = false;
    let ws: WebSocket | null = null;
    let retry = 0;

    const connect = () => {
      ws = openRoomSocket(roomId);
      ws.addEventListener("open", () => {
        retry = 0;
        wsOpenRef.current = true;
        // Re-arm the flusher on (re)connect; outbox entries that survived a
        // page reload or a WS outage now have somewhere to drain to.
        setPending(outbox.list(roomId).length);
      });
      ws.addEventListener("message", (e) => {
        try {
          const frame = JSON.parse(typeof e.data === "string" ? e.data : "");
          if (frame?.type === "message" && frame.message) {
            applyServerMessage(frame.message, frame.clientId ?? null);
          }
        } catch { /* ignore malformed frames */ }
      });
      ws.addEventListener("close", () => {
        wsOpenRef.current = false;
        if (closed) return;
        retry = Math.min(retry + 1, 5);
        setTimeout(connect, retry * 500);
      });
    };
    connect();
    return () => { closed = true; ws?.close(); };
  }, [roomId, applyServerMessage]);

  // Follow the timeline while pinned to the bottom. `useLayoutEffect`
  // so the new message never flashes above the fold before we scroll.
  // Bail when the user has scrolled back so we don't yank them away.
  useLayoutEffect(() => {
    if (!isPinned) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [isPinned, messages]);

  // Track scroll position. Show the jump button once the gap from the
  // bottom exceeds one viewport; re-pin when we land at the bottom so
  // a manual scroll-to-bottom resumes auto-follow.
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const m = {
      scrollTop:    el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    };
    setIsPinned(isAtBottom(m));
    setShowJumpButton(isMoreThanOneViewportFromBottom(m));
  }, []);

  // Eagerly hide the button on click so it doesn't linger through the
  // smooth-scroll animation; `onScroll` will keep state coherent once
  // the scroll lands.
  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    setIsPinned(true);
    setShowJumpButton(false);
  }, []);

  // Outbox flusher. Re-runs whenever `pending` changes (which is whenever we
  // enqueue, dequeue, or reconnect). Drains entries sequentially so the
  // server processes them in submit order; the unique `client_id` index in
  // Room makes the POSTs idempotent if we crash mid-drain.
  useEffect(() => {
    if (pending === 0) return;
    let cancelled = false;
    (async () => {
      for (const entry of outbox.list(roomId)) {
        if (cancelled) return;
        try {
          const resp = await postRoomMessage(roomId, entry.parts, entry.clientId);
          if (cancelled) return;
          applyServerMessage(resp.message, resp.clientId ?? entry.clientId);
          outbox.remove(roomId, entry.clientId);
          if (resp.threadId) navigate({ kind: "thread", roomId, threadId: resp.threadId });
        } catch {
          // Leave the entry in the outbox; the next reconnect (or the next
          // user send) will trigger another flush attempt.
          break;
        }
      }
      if (!cancelled) setPending(outbox.list(roomId).length);
    })();
    return () => { cancelled = true; };
  }, [pending, roomId, applyServerMessage]);

  const send = useCallback(async () => {
    const raw = input.trim();
    if (!raw || sending) return;
    // Serialise `@handle` to `<user:ID>` / `<agent:ID>` tokens before send.
    // The token form is what gets persisted; the @-handle was just typing UX.
    const text = serializeMentions(raw, resolveHandle);

    setSending(true);
    setInput("");

    const clientId = outbox.newClientId();
    const parts = [{ type: "text" as const, text }];
    const optimistic: AppMessage = {
      id:    clientId,
      role:  "user",
      parts,
      metadata: {
        author:    { kind: "user", id: me.userId, email: me.email, name: me.name },
        createdAt: Date.now(),
      },
    };
    outbox.enqueue(roomId, { clientId, parts, createdAt: optimistic.metadata.createdAt });
    setMessages(prev => [...prev, optimistic]);
    setPending(outbox.list(roomId).length);
    // Submitting a new message implies the user wants to follow the
    // timeline again. Re-engage the scroll pin and scroll down so the
    // optimistic message they just appended is in view without manual
    // intervention.
    scrollToBottom();

    try {
      const resp = await postRoomMessage(roomId, parts, clientId);
      applyServerMessage(resp.message, resp.clientId ?? clientId);
      outbox.remove(roomId, clientId);
      setPending(outbox.list(roomId).length);
      if (resp.threadId) navigate({ kind: "thread", roomId, threadId: resp.threadId });
    } catch (e) {
      // The optimistic message and outbox entry stay put. The flusher will
      // retry on reconnect; the user sees their message immediately and a
      // “queued” indicator until the POST lands.
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  }, [input, sending, roomId, me, applyServerMessage, scrollToBottom, resolveHandle]);

  return (
    <section className="flex h-full min-w-0 flex-col border-r border-kumo-line">
      <header className="flex h-14 flex-shrink-0 items-center gap-2 border-b border-kumo-line px-5">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-md font-semibold">{meta?.name ?? "Loading…"}</h1>
          {meta && (
            <div className="mt-0.5 flex items-center gap-2 text-xs text-kumo-inactive">
              <span>{messages.length} message{messages.length === 1 ? "" : "s"}</span>
              {pending > 0 && (
                <span
                  className="rounded bg-yellow-500/10 px-1.5 py-0.5 text-yellow-300"
                  title="Messages queued locally; will send when the connection comes back"
                >
                  {pending} queued
                </span>
              )}
            </div>
          )}
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Room options"
              disabled={!meta}
            >
              <ChevronDown className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onSelect={() => setConfirmDelete(true)}
              className="text-red-300 focus:bg-red-900/40 focus:text-red-200"
            >
              Delete room…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      {error && (
        <div className="mx-5 my-3 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          {error}
        </div>
      )}

      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="chat-panel flex-1 overflow-y-auto"
        >
          <div className="space-y-1 px-4 py-5">
            {messages.length === 0 && !error && (
              <div className="px-2 py-12 text-center text-sm text-kumo-inactive">
                No messages yet. Say hi 👋 — mention{" "}
                <code className="rounded bg-kumo-recessed px-1 py-0.5">@agent</code>{" "}
                to start a thread.
              </div>
            )}
            {messages.map(m => (
              <TopLevelMessage
                key={m.id}
                message={m}
                active={Boolean(activeThreadId && m.metadata.threadId === activeThreadId)}
                onOpenThread={() => {
                  if (m.metadata.threadId) {
                    navigate({ kind: "thread", roomId, threadId: m.metadata.threadId });
                  }
                }}
              />
            ))}
          </div>
        </div>

        {/*
         * Jump-to-bottom button. Same pattern as ThreadPanel — floats
         * just above the composer when the user has scrolled back more
         * than a viewport. `pointer-events-none` on the wrapper means
         * the gap on either side of the button doesn't eat clicks on
         * the timeline underneath; the button itself re-enables them.
         */}
        {showJumpButton && (
          <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
            <Button
              size="icon-sm"
              variant="secondary"
              aria-label="Jump to latest message"
              onClick={scrollToBottom}
              className="pointer-events-auto rounded-full border border-kumo-line bg-kumo-elevated/90 shadow-lg backdrop-blur hover:bg-kumo-elevated"
            >
              <ChevronDown className="size-4" />
            </Button>
          </div>
        )}
      </div>

      <div className="flex-shrink-0 bg-kumo-base px-5 pb-4 pt-2">
        <div className="prompt-input rounded-2xl border px-4 pb-2 pt-3">
          <MentionTextarea
            rows={1}
            value={input}
            onChange={setInput}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); }
            }}
            placeholder={meta ? `Start a new thread in #${meta.name}…` : "Loading…"}
            disabled={!meta || sending}
            className="block w-full resize-none border-0 bg-transparent p-0 text-base leading-6 outline-none placeholder:text-kumo-inactive disabled:opacity-50"
          />
          <div className="flex items-end justify-between gap-2 pt-2">
            <span className="text-xs font-medium text-kumo-inactive" title="current model">
              {model}
            </span>
            <Button
              size="icon-sm"
              aria-label="Send"
              onClick={() => void send()}
              disabled={!meta || sending || !input.trim()}
              className="bg-kumo-brand text-white hover:bg-kumo-brand-hover"
            >
              <ArrowUp size={15} strokeWidth={2.5} />
            </Button>
          </div>
        </div>
      </div>
      <ConfirmDialog
        open={confirmDelete}
        title={meta ? `Delete “${meta.name}”?` : "Delete this room?"}
        description={
          <>
            This permanently removes the room, its messages, and every
            thread spawned from it. This can’t be undone.
          </>
        }
        busy={deleting}
        onConfirm={() => void doDeleteRoom()}
        onCancel={() => setConfirmDelete(false)}
      />
    </section>
  );
}

function TopLevelMessage({
  message,
  active,
  onOpenThread,
}: {
  message:      AppMessage;
  active:       boolean;
  onOpenThread: () => void;
}) {
  const name = authorName(message);
  const idx  = authorIdx(authorKey(message));
  const text = message.parts.filter(p => p.type === "text").map(p => p.text).join("\n");
  const threadId = message.metadata.threadId;
  const hasThread = Boolean(threadId);
  const [summary, setSummary] = useState<string>("");
  const { isUnread } = useReceipts();
  const threadUnread = hasThread && threadId ? isUnread("thread", threadId) : false;

  // The summary is produced by a background task on the Agent DO, so the
  // UI is purely a reader of the cached value. We fetch on mount, refetch
  // when `active` flips (user navigated back from the thread), and poll
  // slowly so a freshly-generated summary appears without a page reload.
  // The endpoint is a cheap storage read — no model call — so the poll is
  // effectively free.
  useEffect(() => {
    if (!threadId) return;
    let cancelled = false;
    const load = () => {
      fetchThreadSummary(threadId)
        .then(s => { if (!cancelled) setSummary(s); })
        .catch(() => { /* swallow — summary is best-effort */ });
    };
    load();
    const id = window.setInterval(load, 15_000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [threadId, active]);

  return (
    <div className={`group rounded-lg px-3 py-3 transition-colors ${
      active ? "bg-kumo-elevated" : "hover:bg-kumo-elevated"
    }`}>
      <div className="flex items-start gap-3">
        <div className={`flex size-9 flex-shrink-0 items-center justify-center rounded-md font-semibold text-white shadow-sm ring-1 ring-black/5 ${AVATAR_PALETTE[idx]}`}>
          {initials(name).slice(0, 1)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="text-base font-semibold text-kumo-default">{name}</span>
            <span className="text-xs text-kumo-inactive tabular-nums">{relTime(message.metadata.createdAt)}</span>
          </div>
          <div className="mt-1 whitespace-pre-wrap text-base leading-6 text-kumo-default">
            <MentionText text={text} />
          </div>
          {hasThread && summary && (
            <div className="mt-3 flex items-start gap-2 rounded-lg border border-kumo-line/60 bg-kumo-base/40 px-3 py-2 text-sm leading-5 text-kumo-default">
              <Sparkles size={13} strokeWidth={2} className="mt-0.5 flex-shrink-0 text-kumo-brand" />
              <span className="min-w-0">{summary}</span>
            </div>
          )}
          {hasThread && (
            <button
              onClick={onOpenThread}
              className={`mt-2 flex w-full items-center gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors ${
                active
                  ? "border-kumo-line bg-kumo-base"
                  : "border-transparent hover:border-kumo-line hover:bg-kumo-base"
              }`}
            >
              <span className="flex items-center gap-1.5 text-sm font-semibold text-kumo-brand">
                Open thread
                {threadUnread && (
                  <span
                    aria-label="Unread"
                    title="Unread messages"
                    className="size-2 rounded-full bg-kumo-brand"
                  />
                )}
              </span>
              <span className="ml-auto flex items-center gap-1 text-xs text-kumo-inactive opacity-0 transition-opacity group-hover:opacity-100">
                View
                <ChevronRight size={11} strokeWidth={2.5} />
              </span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
