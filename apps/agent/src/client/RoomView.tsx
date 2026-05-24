/**
 * Center pane: a room's message timeline + composer.
 *
 * Subscribes to the room's WebSocket for live updates. When the user posts
 * a message that mentions `@persona`, the server returns a threadId and we
 * navigate into the thread panel automatically.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchRoomMeta, fetchRoomMessages, openRoomSocket, postRoomMessage,
} from "./api.js";
import { navigate } from "./nav.js";
import { initials, relTime, s } from "./styles.js";
import type { AppMessage, RoomMeta } from "../room-do.js";

export function RoomView({
  roomId,
  highlightThreadId,
}: {
  roomId:             string;
  highlightThreadId?: string;
}) {
  const [meta,     setMeta]     = useState<RoomMeta | null>(null);
  const [messages, setMessages] = useState<AppMessage[]>([]);
  const [error,    setError]    = useState<string | null>(null);
  const [input,    setInput]    = useState("");
  const [sending,  setSending]  = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Initial load: meta + history. We don't paginate yet; the DO caps at 500.
  useEffect(() => {
    let cancelled = false;
    setMeta(null); setMessages([]); setError(null);
    (async () => {
      try {
        const [m, ms] = await Promise.all([fetchRoomMeta(roomId), fetchRoomMessages(roomId)]);
        if (cancelled) return;
        setMeta(m);
        setMessages(ms);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => { cancelled = true; };
  }, [roomId]);

  // Live: subscribe to the room socket for fanout. Reconnects on close.
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
              // De-dupe: the poster already appended optimistically through
              // the POST response. Skip if we already have this id.
              if (prev.some(m => m.id === frame.message.id)) return prev;
              return [...prev, frame.message];
            });
          }
        } catch { /* ignore malformed frame */ }
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

  // Auto-scroll to bottom on new messages.
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages.length]);

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
    <main style={s.main}>
      <header style={s.mainHeader}>
        <div>
          <div style={s.mainTitle}>{meta?.name ?? "Loading…"}</div>
          {meta && <div style={s.mainSubtitle}>{messages.length} message{messages.length === 1 ? "" : "s"}</div>}
        </div>
      </header>

      {error && <div style={s.errorBox}>{error}</div>}

      <div style={s.messages}>
        {!error && messages.length === 0 && (
          <div style={s.empty}>No messages yet. Say hi 👋 — mention @go, @zig or @cloudflare-worker to start a thread.</div>
        )}
        {messages.map(m => (
          <MessageRow
            key={m.id}
            message={m}
            highlighted={Boolean(highlightThreadId && m.metadata.threadId === highlightThreadId)}
            onOpenThread={(tid) => navigate({ kind: "thread", roomId, threadId: tid })}
          />
        ))}
        <div ref={bottomRef} />
      </div>

      <div style={s.composer}>
        <textarea
          style={s.composerInput}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); }
          }}
          placeholder={meta ? `Message #${meta.name}…   (mention @go to start a thread)` : "Loading…"}
          rows={2}
          disabled={!meta || sending}
        />
        <button style={s.primaryBtnLg} onClick={() => void send()} disabled={!meta || sending || !input.trim()}>
          Send
        </button>
      </div>
    </main>
  );
}

function MessageRow({
  message, highlighted, onOpenThread,
}: {
  message:      AppMessage;
  highlighted:  boolean;
  onOpenThread: (threadId: string) => void;
}) {
  const author    = message.metadata.author;
  const authorName = author.kind === "user" ? author.name : author.name;
  const text      = message.parts.filter(p => p.type === "text").map(p => p.text).join("\n");
  const threadId  = message.metadata.threadId;

  return (
    <div style={{
      ...s.messageRow,
      ...(highlighted ? { background: "#1a1810", padding: "8px 12px", borderRadius: 8,
                          margin: "-8px -12px" } : {}),
    }}>
      <div style={{ ...s.authorAvatar, background: authorColor(authorName) }}>{initials(authorName)}</div>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={s.authorRow}>
          <span style={s.authorName}>{authorName}</span>
          <span style={s.authorTime}>{relTime(message.metadata.createdAt)}</span>
        </div>
        <div style={s.messageBody}>{text}</div>
        {threadId && (
          <a
            style={s.threadLink}
            onClick={(e) => { e.preventDefault(); onOpenThread(threadId); }}
            href={`#thread-${threadId}`}
          >
            💬 Open thread
          </a>
        )}
      </div>
    </div>
  );
}

function authorColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360}, 35%, 30%)`;
}
