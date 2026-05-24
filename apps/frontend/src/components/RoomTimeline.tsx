/**
 * Centre pane: live timeline of a room's top-level messages plus the
 * composer that appends new ones.
 *
 * Subscribes to the room's WebSocket for live fanout from other users,
 * de-duplicates messages we appended optimistically, and auto-navigates
 * into the thread panel when a posted message returns a threadId.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  ChevronRight,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { MentionText } from "@/components/MentionText";
import { MentionTextarea } from "@/components/MentionTextarea";


import {
  fetchRoomMeta,
  fetchRoomMessages,
  openRoomSocket,
  postRoomMessage,
} from "@/lib/api";
import type { AppMessage, RoomMeta } from "@/lib/api";
import { navigate } from "@/lib/nav";
import { initials, relTime } from "@/lib/utils";

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
  roomId,
  activeThreadId,
  model,
}: {
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
  const bottomRef = useRef<HTMLDivElement>(null);

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

  // Live fanout via the RoomDO WebSocket. Reconnects with capped backoff.
  useEffect(() => {
    let closed = false;
    let ws: WebSocket | null = null;
    let retry = 0;

    const connect = () => {
      ws = openRoomSocket(roomId);
      ws.addEventListener("message", (e) => {
        try {
          const frame = JSON.parse(typeof e.data === "string" ? e.data : "");
          if (frame?.type === "message" && frame.message) {
            setMessages(prev => {
              // De-dupe: poster already appended optimistically through the
              // POST response. Skip if the id is already here.
              if (prev.some(m => m.id === frame.message.id)) return prev;
              return [...prev, frame.message];
            });
          }
        } catch { /* ignore malformed frames */ }
      });
      ws.addEventListener("close", () => {
        if (closed) return;
        retry = Math.min(retry + 1, 5);
        setTimeout(connect, retry * 500);
      });
    };
    connect();
    return () => { closed = true; ws?.close(); };
  }, [roomId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || sending) return;
    setSending(true);
    setInput("");
    try {
      const { message, threadId } = await postRoomMessage(roomId, [{ type: "text", text }]);
      setMessages(prev => prev.some(m => m.id === message.id) ? prev : [...prev, message]);
      if (threadId) navigate({ kind: "thread", roomId, threadId });
    } catch (e) {
      setError((e as Error).message);
      setInput(text);  // restore so the user can retry
    } finally {
      setSending(false);
    }
  }, [input, sending, roomId]);

  return (
    <section className="flex h-full min-w-0 flex-col border-r border-kumo-line">
      <header className="flex h-14 flex-shrink-0 items-center gap-2 border-b border-kumo-line px-5">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-md font-semibold">{meta?.name ?? "Loading…"}</h1>
          {meta && (
            <div className="mt-0.5 flex items-center gap-2 text-xs text-kumo-inactive">
              <span>{messages.length} message{messages.length === 1 ? "" : "s"}</span>
            </div>
          )}
        </div>

      </header>

      {error && (
        <div className="mx-5 my-3 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          {error}
        </div>
      )}

      <div className="chat-panel flex-1 overflow-y-auto">
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
          <div ref={bottomRef} />
        </div>
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
  const hasThread = Boolean(message.metadata.threadId);

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
          {hasThread && (
            <button
              onClick={onOpenThread}
              className={`mt-3 flex w-full items-center gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors ${
                active
                  ? "border-kumo-line bg-kumo-base"
                  : "border-transparent hover:border-kumo-line hover:bg-kumo-base"
              }`}
            >
              <span className="text-sm font-semibold text-kumo-brand">Open thread</span>
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
