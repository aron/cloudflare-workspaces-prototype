/**
 * Right pane: a live agent thread rendered against the same Agent DO that
 * RoomDO seeded when the room message minted the thread. Uses
 * `useAgentChat` from @cloudflare/ai-chat to drive a WebSocket session,
 * and renders each message part through the AI Elements components.
 *
 * The room message that opened this thread is shown at the top as a
 * "quoted root" so the thread always has its own context.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { isToolUIPart, getToolName } from "ai";
import { ArrowUp, ChevronDown, X } from "lucide-react";

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
import { MentionHighlighter } from "@/components/MentionHighlighter";
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

import { deleteThread, fetchRoomMessages } from "@/lib/api";
import type { AppMessage } from "@/lib/api";
import { FileViewer, type FileViewerEntry } from "@/components/FileViewer";
import { PathAutocomplete } from "@/components/PathAutocomplete";
import { ExecToolView } from "@/components/ExecToolView";
import { parseBangInput } from "@/lib/bang-parser.js";
import { acceptCompletion } from "@/lib/path-autocomplete.js";
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
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [steerQueue, setSteerQueue] = useState<string[]>([]);
  const [viewerEntries, setViewerEntries] = useState<FileViewerEntry[]>([]);
  const autocompleteHandlers = useRef<{
    moveUp(): void; moveDown(): void; accept(): void; isOpen(): boolean;
  } | null>(null);

  const doDeleteThread = useCallback(async () => {
    setDeleting(true);
    try {
      await deleteThread(roomId, threadId);
      // RoomDO broadcasts thread:deleted so the timeline updates on its own.
      // Bounce the user back to the room view.
      navigate({ kind: "room", roomId });
    } catch (e) {
      console.error("delete thread failed", e);
    } finally {
      setDeleting(false);
      setConfirmDelete(false);
    }
  }, [roomId, threadId]);

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

  const { messages, sendMessage, isStreaming, isServerStreaming, stop } = useAgentChat({ agent });

  // Show the stop button whenever a turn is in progress from *either* the
  // client's vantage (an in-flight sendMessage call) or the server's (a
  // tool round-trip pushing the next continuation). `isStreaming` alone
  // misses the gap between tool calls where the model is wedged on the
  // server — exactly the case where users need a stop button.
  const turnInFlight = isStreaming || isServerStreaming;

  // Submit the current input. Behaviour depends on whether the agent is
  // mid-turn: when idle we send straight to the model; while a turn is in
  // flight we enqueue locally and drain on completion. The composer is the
  // same control either way — only the placeholder and the helper line change.
  const submit = useCallback(() => {
    const text = input.trim();
    if (!text) return;

    // Intercept !/<absolute-path> as an inline file-viewer command. Local-only:
    // never reaches the agent, never persisted.
    const parsed = parseBangInput(text);
    if (parsed.kind === "bang") {
      setInput("");
      setViewerEntries(prev => [...prev, {
        id:        crypto.randomUUID(),
        createdAt: Date.now(),
        path:      parsed.path,
        url:       `/api/threads/${threadId}/files${parsed.path}`,
      }]);
      return;
    }
    if (parsed.kind === "invalid") {
      // Surface the validation error without sending anything. A toast
      // would be nicer but we don't have one in this app; the user gets
      // immediate feedback by seeing their input stay put.
      console.warn(`[viewer] invalid path: ${parsed.reason}`);
      return;
    }

    setInput("");
    if (turnInFlight) {
      setSteerQueue(q => [...q, text]);
    } else {
      sendMessage({ role: "user", parts: [{ type: "text", text }] });
    }
  }, [input, turnInFlight, sendMessage, threadId]);

  const dismissViewerEntry = useCallback((id: string) => {
    setViewerEntries(prev => prev.filter(e => e.id !== id));
  }, []);

  // ── Steering ──────────────────────────────────────────────────────────
  //
  // Messages submitted while a turn is in flight are buffered locally and
  // drained as soon as the current turn finishes, so they show up as user
  // turns in the queue rather than mid-stream interruptions. The drain
  // effect below feeds them to `sendMessage` one render at a time.
  useEffect(() => {
    if (turnInFlight || steerQueue.length === 0) return;
    // Drain one message per render so each goes through `sendMessage`'s own
    // queueing and we don't fire a burst of WS frames at the agent.
    const [next, ...rest] = steerQueue;
    setSteerQueue(rest);
    sendMessage({ role: "user", parts: [{ type: "text", text: next }] });
  }, [turnInFlight, steerQueue, sendMessage]);

  // Download a tar archive of the agent's session state (messages + VFS +
  // metadata). Useful for filing bug reports — drop it next to a repro.
  const downloadDebugTar = useCallback(async () => {
    const res = await fetch(`/api/threads/${threadId}/tar`, { credentials: "include" });
    if (!res.ok) {
      console.error("debug tar download failed", res.status, await res.text());
      return;
    }
    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href     = url;
    link.download = `thread-${threadId}.tar`;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }, [threadId]);

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

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Thread options"
            >
              <ChevronDown className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => { void downloadDebugTar(); }}>
              Download debug tarball
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => setConfirmDelete(true)}
              className="text-red-300 focus:bg-red-900/40 focus:text-red-200"
            >
              Delete thread…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

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
              <p className="mt-1 whitespace-pre-wrap text-sm leading-5 text-kumo-default"><MentionText text={rootInitial.text} /></p>
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
                <div key={m.id} className="flex flex-row-reverse items-start gap-2.5">
                  <div className={`flex size-7 flex-shrink-0 items-center justify-center rounded-md text-xs font-semibold text-white ${AVATAR_PALETTE[idx]}`}>
                    {initials(name).slice(0, 1)}
                  </div>
                  <Message from="user" className="ml-0 max-w-full flex-1">
                    <div className="mb-1 text-right text-2xs text-kumo-inactive">{name}</div>
                    <MessageContent>
                      <div className="whitespace-pre-wrap"><MentionText text={text} /></div>
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
                          <MentionHighlighter>
                            <MessageResponse>{part.text}</MessageResponse>
                          </MentionHighlighter>
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
                      const toolCallId = (part as { toolCallId?: string }).toolCallId;
                      // Tool-call duration in ms attached by the agent in
                      // `afterToolCall` once the call settles. Falls back to
                      // the exec snapshot's own `durationMs` so old persisted
                      // exec parts keep their badge after the rollout.
                      const callDurationMs =
                        (part as { callDurationMs?: number }).callDurationMs
                        ?? (output as { durationMs?: number } | null)?.durationMs;

                      // Custom chrome for exec — streams stdout/stderr live,
                      // colours green on exit 0, red on non-zero or error.
                      if (name === "exec") {
                        return (
                          <ExecToolView
                            key={i}
                            input={input as { command?: string; cwd?: string } | undefined}
                            // eslint-disable-next-line @typescript-eslint/no-explicit-any
                            output={output as any}
                            errorText={errorText}
                            state={part.state}
                            toolCallId={toolCallId}
                            onCancel={(id) => { void agent.call("cancelToolCall", [id]).catch(() => {}); }}
                          />
                        );
                      }
                      // "Running" states: the model has emitted the call but no
                      // result has landed yet. Show a Cancel affordance so the
                      // user can fail a wedged tool without nuking the whole turn.
                      const isRunning = part.state === "input-streaming" || part.state === "input-available";
                      return (
                        <Tool key={i} defaultOpen={false}>
                          <ToolHeader type={`tool-${name}` as `tool-${string}`} state={part.state} callDurationMs={callDurationMs} />
                          <ToolContent>
                            {input != null && <ToolInput input={input} />}
                            {isRunning && toolCallId && (
                              <div className="px-3 pb-2 pt-1">
                                <Button
                                  size="sm"
                                  onClick={() => {
                                    void agent.call("cancelToolCall", [toolCallId]).catch(() => {});
                                  }}
                                  className="h-7 bg-red-900/40 text-red-300 hover:bg-red-900/60"
                                >
                                  Cancel tool call
                                </Button>
                              </div>
                            )}
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

          {viewerEntries.map(entry => (
            <FileViewer key={entry.id} entry={entry} onDismiss={dismissViewerEntry} />
          ))}

          {turnInFlight && (
            <div className="text-sm text-kumo-inactive">●●●</div>
          )}
        </div>
      </div>

      <div className="flex-shrink-0 bg-kumo-base px-4 pb-3 pt-2">
        <div className={`prompt-input relative rounded-2xl border px-3.5 pb-2 pt-3 ${turnInFlight ? "border-kumo-brand/40" : ""}`}>
          <PathAutocomplete
            threadId={threadId}
            text={input}
            onAccept={(entry) => {
              const next = acceptCompletion(input, entry);
              setInput(next.text);
            }}
            registerHandlers={(h) => { autocompleteHandlers.current = h; }}
          />
          <MentionTextarea
            rows={1}
            value={input}
            onChange={setInput}
            onKeyDown={(e) => {
              const ac = autocompleteHandlers.current;
              if (ac?.isOpen()) {
                if (e.key === "ArrowDown") { e.preventDefault(); ac.moveDown(); return; }
                if (e.key === "ArrowUp")   { e.preventDefault(); ac.moveUp();   return; }
                if (e.key === "Tab")       { e.preventDefault(); ac.accept();   return; }
              }
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
            }}
            placeholder={turnInFlight ? "Steer the agent…" : "Reply…"}
            disabled={status !== "connected"}
            className="block w-full resize-none border-0 bg-transparent p-0 text-base leading-6 outline-none placeholder:text-kumo-inactive disabled:opacity-50"
          />
          <div className="flex items-end justify-between gap-2 pt-2">
            <span className="text-2xs font-medium text-kumo-inactive" title="current model">
              {turnInFlight
                ? steerQueue.length > 0
                  ? `steering · ${steerQueue.length} queued`
                  : "steering… enter to queue"
                : model}
            </span>
            <div className="flex items-center gap-2">
              {turnInFlight && (
                <Button
                  size="sm"
                  onClick={stop}
                  className="h-7 bg-red-900/40 text-red-300 hover:bg-red-900/60"
                >
                  Stop
                </Button>
              )}
              <Button
                size="icon-sm"
                aria-label={turnInFlight ? "Queue steer" : "Send"}
                onClick={submit}
                disabled={status !== "connected" || !input.trim()}
                className={`h-7 w-7 text-white ${turnInFlight ? "bg-kumo-brand/70 hover:bg-kumo-brand" : "bg-kumo-brand hover:bg-kumo-brand-hover"}`}
              >
                <ArrowUp size={13} strokeWidth={2.5} />
              </Button>
            </div>
          </div>
        </div>
      </div>
      <ConfirmDialog
        open={confirmDelete}
        title="Delete this thread?"
        description={
          <>
            The agent session and its messages will be removed. The
            originating message stays in the room.
          </>
        }
        busy={deleting}
        onConfirm={() => void doDeleteThread()}
        onCancel={() => setConfirmDelete(false)}
      />
    </aside>
  );
}
