/**
 * Right pane: a live agent thread rendered against the same Agent DO that
 * RoomDO seeded when the room message minted the thread. Uses
 * `useAgentChat` from @cloudflare/ai-chat to drive a WebSocket session,
 * and renders each message part through the AI Elements components.
 *
 * The room message that opened this thread is shown at the top as a
 * "quoted root" so the thread always has its own context.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { isToolUIPart, getToolName } from "ai";
import { ArrowUp, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from "@/components/ai-elements/tool";

import { fetchRoomMessages } from "@/lib/api";
import type { AppMessage } from "@/lib/api";
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

export function ThreadPanel({
  roomId,
  threadId,
  model,
}: {
  roomId:   string;
  threadId: string;
  /** Human-readable label for the current model. Display-only. */
  model:    string;
}) {
  const [root, setRoot] = useState<AppMessage | null>(null);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<"connecting" | "connected" | "disconnected">("connecting");

  // The "quoted root" is the room message whose metadata.threadId matches
  // the current thread. Look it up from the room's message log.
  useEffect(() => {
    let cancelled = false;
    fetchRoomMessages(roomId).then(messages => {
      if (cancelled) return;
      setRoot(messages.find(m => m.metadata.threadId === threadId) ?? null);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [roomId, threadId]);

  const agent = useAgent({
    agent:   "agent",
    name:    threadId,
    onOpen:  useCallback(() => setStatus("connected"), []),
    onClose: useCallback(() => setStatus("disconnected"), []),
  });

  const { messages, sendMessage, isStreaming, stop } = useAgentChat({ agent });

  const send = useCallback(() => {
    const text = input.trim();
    if (!text || isStreaming) return;
    setInput("");
    sendMessage({ role: "user", parts: [{ type: "text", text }] });
  }, [input, isStreaming, sendMessage]);

  const rootInitial = useMemo(() => {
    if (!root) return null;
    const a = root.metadata.author;
    const name = a.kind === "user" ? a.name : a.name;
    const key  = a.kind === "user" ? a.id   : a.id;
    return {
      name,
      letter: initials(name).slice(0, 1),
      idx:    authorIdx(key),
      text:   root.parts.filter(p => p.type === "text").map(p => p.text).join("\n"),
      time:   relTime(root.metadata.createdAt),
    };
  }, [root]);

  return (
    <aside className="flex h-full flex-col bg-kumo-base">
      <header className="flex h-14 flex-shrink-0 items-center gap-2 border-b border-kumo-line px-5">
        <div className="min-w-0 flex-1">
          <div className="truncate text-base font-semibold">Thread</div>
          <div className="flex items-center gap-2 text-xs text-kumo-inactive">
            <span
              className={`inline-block size-1.5 rounded-full ${
                status === "connected" ? "bg-green-500"
                : status === "connecting" ? "bg-yellow-500"
                : "bg-red-500"
              }`}
            />
            <span>{status}</span>
          </div>
        </div>

        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Close thread"
          onClick={() => navigate({ kind: "room", roomId })}
        >
          <X className="size-4" />
        </Button>
      </header>

      {rootInitial && (
        <div className="border-b border-kumo-line bg-kumo-elevated px-5 py-4">
          <div className="flex items-start gap-2.5">
            <div className={`flex size-7 flex-shrink-0 items-center justify-center rounded-md text-xs font-semibold text-white ${AVATAR_PALETTE[rootInitial.idx]}`}>
              {rootInitial.letter}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <span className="text-sm font-semibold text-kumo-default">{rootInitial.name}</span>
                <span className="text-2xs text-kumo-inactive tabular-nums">{rootInitial.time}</span>
              </div>
              <p className="mt-1 whitespace-pre-wrap text-sm leading-5 text-kumo-default">{rootInitial.text}</p>
            </div>
          </div>
        </div>
      )}

      <div className="chat-panel flex-1 overflow-y-auto">
        <div className="flex flex-col gap-6 px-5 py-4">
          {messages.length === 0 && (
            <div className="py-8 text-center text-sm text-kumo-inactive">
              Thread is starting up…
            </div>
          )}

          {messages.map((m) => {
            if (m.role === "user") {
              const text = m.parts.filter(p => p.type === "text")
                .map(p => (p as { type: "text"; text: string }).text).join("");
              const meta = (m as { metadata?: { author?: { kind?: string; name?: string; id?: string } } }).metadata;
              const author = meta?.author;
              const name = author?.name ?? "You";
              const idx  = authorIdx(author?.id ?? name);
              return (
                <div key={m.id} className="flex items-start gap-2.5">
                  <div className={`flex size-7 flex-shrink-0 items-center justify-center rounded-md text-xs font-semibold text-white ${AVATAR_PALETTE[idx]}`}>
                    {initials(name).slice(0, 1)}
                  </div>
                  <Message from="user" className="ml-0 max-w-full flex-1">
                    <div className="mb-1 text-2xs text-kumo-inactive">{name}</div>
                    <MessageContent>
                      <MessageResponse>{text}</MessageResponse>
                    </MessageContent>
                  </Message>
                </div>
              );
            }

            if (m.role === "assistant") {
              return (
                <Message key={m.id} from="assistant" className="max-w-full">
                  {m.parts.map((part, i) => {
                    if (part.type === "text") {
                      return (
                        <MessageContent key={i}>
                          <MessageResponse>{part.text}</MessageResponse>
                        </MessageContent>
                      );
                    }
                    if (part.type === "reasoning") {
                      const text = (part as { text?: string }).text;
                      if (!text) return null;
                      return (
                        <Reasoning key={i} isStreaming={false} defaultOpen={false}>
                          <ReasoningTrigger />
                          <ReasoningContent>{text}</ReasoningContent>
                        </Reasoning>
                      );
                    }
                    if (isToolUIPart(part)) {
                      const name   = getToolName(part);
                      const input  = (part as { input?: unknown }).input;
                      const output = (part as { output?: unknown }).output;
                      const errorText = (part as { errorText?: string }).errorText;
                      return (
                        <Tool key={i} defaultOpen={false}>
                          <ToolHeader type={`tool-${name}` as `tool-${string}`} state={part.state} />
                          <ToolContent>
                            {input != null && <ToolInput input={input} />}
                            {(output != null || errorText) && (
                              <ToolOutput output={output} errorText={errorText} />
                            )}
                          </ToolContent>
                        </Tool>
                      );
                    }
                    return null;
                  })}
                </Message>
              );
            }
            return null;
          })}

          {isStreaming && (
            <div className="text-sm text-kumo-inactive">●●●</div>
          )}
        </div>
      </div>

      <div className="flex-shrink-0 bg-kumo-base px-4 pb-3 pt-2">
        <div className="prompt-input rounded-2xl border px-3.5 pb-2 pt-3">
          <textarea
            rows={1}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
            placeholder="Reply…"
            disabled={status !== "connected"}
            className="block w-full resize-none border-0 bg-transparent p-0 text-base leading-6 outline-none placeholder:text-kumo-inactive disabled:opacity-50"
          />
          <div className="flex items-end justify-between gap-2 pt-2">
            <span className="text-2xs font-medium text-kumo-inactive" title="current model">
              {model}
            </span>
            {isStreaming ? (
              <Button
                size="sm"
                onClick={stop}
                className="h-7 bg-red-900/40 text-red-300 hover:bg-red-900/60"
              >
                Stop
              </Button>
            ) : (
              <Button
                size="icon-sm"
                aria-label="Send"
                onClick={send}
                disabled={status !== "connected" || !input.trim()}
                className="h-7 w-7 bg-kumo-brand text-white hover:bg-kumo-brand-hover"
              >
                <ArrowUp size={13} strokeWidth={2.5} />
              </Button>
            )}
          </div>
        </div>
      </div>
    </aside>
  );
}
