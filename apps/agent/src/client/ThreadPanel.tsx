/**
 * Right-rail thread panel. Renders an `AIChatAgent` session keyed by the
 * threadId (Agent DO `idFromName(threadId)`). Almost identical to the
 * pre-refactor `App` component, just laid out as a sidebar.
 */

import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { isToolUIPart, getToolName } from "ai";
import { useCallback, useEffect, useRef, useState } from "react";
import { marked } from "marked";
import { navigate } from "./nav.js";
import { colors, s } from "./styles.js";

marked.setOptions({ gfm: true, breaks: true });
function Markdown({ text }: { text: string }) {
  const html = marked.parse(text, { async: false }) as string;
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
}

export function ThreadPanel({
  roomId, threadId,
}: {
  roomId: string; threadId: string;
}) {
  const [input,  setInput]  = useState("");
  const [status, setStatus] = useState("connecting");
  const bottomRef = useRef<HTMLDivElement>(null);

  const agent = useAgent({
    agent:   "agent",
    name:    threadId,
    onOpen:  useCallback(() => setStatus("connected"), []),
    onClose: useCallback(() => setStatus("disconnected"), []),
  });

  const { messages, sendMessage, isStreaming, stop } = useAgentChat({ agent });

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const send = useCallback(() => {
    const text = input.trim();
    if (!text || isStreaming) return;
    setInput("");
    sendMessage({ role: "user", parts: [{ type: "text", text }] });
  }, [input, isStreaming, sendMessage]);

  return (
    <aside style={s.thread}>
      <div style={s.threadHeader}>
        <div>
          <div style={s.threadTitle}>Thread</div>
          <div style={s.threadSubtitle}>
            <span style={{
              display: "inline-block", width: 6, height: 6, borderRadius: "50%",
              marginRight: 6,
              background: status === "connected" ? colors.ok
                : status === "connecting" ? colors.warn : colors.err,
            }} />
            {status}
          </div>
        </div>
        <button style={s.closeBtn} onClick={() => navigate({ kind: "room", roomId })} aria-label="Close thread">✕</button>
      </div>

      <div style={threadStyles.messages}>
        {messages.length === 0 && (
          <div style={s.empty}>Thread is starting up…</div>
        )}

        {messages.map((m) => {
          if (m.role === "user") {
            const text = m.parts.filter(p => p.type === "text")
              .map(p => (p as { type: "text"; text: string }).text).join("");
            // Show the author name above the bubble so multi-human threads
            // are readable. Falls back silently when metadata is absent.
            const author = (m.metadata as { author?: { name?: string } } | undefined)?.author;
            return (
              <div key={m.id} style={threadStyles.userRow}>
                {author?.name && <div style={threadStyles.userAuthor}>{author.name}</div>}
                <div style={threadStyles.user}>{text}</div>
              </div>
            );
          }

          if (m.role === "assistant") {
            const rendered = m.parts.map((part, i) => {
              if (part.type === "text") return <Markdown key={i} text={part.text} />;
              if (part.type === "reasoning") {
                const text = (part as { text?: string }).text;
                if (!text) return null;
                return (
                  <details key={i} style={threadStyles.reasoning} open>
                    <summary style={threadStyles.reasoningSummary}>thinking…</summary>
                    <div style={threadStyles.reasoningBody}>{text}</div>
                  </details>
                );
              }
              if (isToolUIPart(part)) {
                const name   = getToolName(part);
                const input  = (part as { input?:     unknown }).input;
                const output = (part as { output?:    unknown }).output;
                const error  = (part as { errorText?: string }).errorText;
                const running = part.state === "input-available" || part.state === "input-streaming";
                const done    = part.state === "output-available";
                const failed  = part.state === "output-error";
                return (
                  <div key={i} style={threadStyles.tool}>
                    <div style={threadStyles.toolHeader}>
                      <span>{running ? "⚙" : done ? "✓" : failed ? "✗" : "⚙"}</span>
                      <strong>{name}</strong>
                      <span style={threadStyles.toolState}>{part.state}</span>
                    </div>
                    {input != null && (
                      <pre style={threadStyles.pre}>{JSON.stringify(input, null, 2)}</pre>
                    )}
                    {done && output != null && (
                      <pre style={{ ...threadStyles.pre, color: "#7ec87e" }}>{JSON.stringify(output, null, 2)}</pre>
                    )}
                    {failed && error && (
                      <pre style={{ ...threadStyles.pre, color: colors.err }}>{error}</pre>
                    )}
                  </div>
                );
              }
              return null;
            }).filter(Boolean);
            if (rendered.length === 0) return null;
            return <div key={m.id} style={threadStyles.assistant}>{rendered}</div>;
          }
          return null;
        })}

        {isStreaming && <div style={threadStyles.thinking}>●●●</div>}
        <div ref={bottomRef} />
      </div>

      <div style={threadStyles.form}>
        <textarea
          style={threadStyles.input}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
          placeholder="Reply…"
          rows={2}
          disabled={status !== "connected"}
        />
        {isStreaming
          ? <button style={threadStyles.stopBtn} onClick={stop}>Stop</button>
          : <button style={threadStyles.sendBtn} onClick={send} disabled={status !== "connected" || !input.trim()}>Send</button>
        }
      </div>
    </aside>
  );
}

const threadStyles: Record<string, React.CSSProperties> = {
  messages:   { flex: 1, overflowY: "auto", padding: "12px 14px", display: "flex",
                flexDirection: "column", gap: 10, fontSize: "0.85rem" },
  userRow:    { display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2,
                maxWidth: "92%", alignSelf: "flex-end" },
  userAuthor: { color: colors.textMuted, fontSize: "0.72rem", paddingRight: 4 },
  user:       { background: colors.user, padding: "8px 12px", borderRadius: 8,
                alignSelf: "flex-end", maxWidth: "92%", whiteSpace: "pre-wrap",
                fontSize: "0.85rem", lineHeight: 1.5 },
  assistant:  { background: "#1e1e1e", border: `1px solid ${colors.borderStrong}`,
                padding: "8px 12px", borderRadius: 8, alignSelf: "flex-start",
                maxWidth: "100%", fontSize: "0.85rem", lineHeight: 1.55,
                display: "flex", flexDirection: "column", gap: 6 },
  tool:       { background: "#111811", border: "1px solid #2a3a2a", padding: "6px 10px",
                borderRadius: 6, fontSize: "0.76rem" },
  toolHeader: { display: "flex", alignItems: "center", gap: 6, marginBottom: 4 },
  toolState:  { color: colors.textMuted, fontSize: "0.7rem", marginLeft: "auto" },
  pre:        { margin: "2px 0 0", fontFamily: "monospace", fontSize: "0.72rem", lineHeight: 1.4,
                overflowX: "auto", maxHeight: 200, color: colors.textDim,
                whiteSpace: "pre-wrap", wordBreak: "break-all" },
  thinking:   { color: colors.textMuted, fontSize: "1.1rem", letterSpacing: 4, paddingLeft: 4 },
  reasoning:       { background: "#111", border: `1px solid ${colors.borderStrong}`,
                     borderRadius: 4, padding: "5px 8px", margin: "2px 0", fontSize: "0.78rem" },
  reasoningSummary:{ color: colors.textMuted, cursor: "pointer", userSelect: "none" },
  reasoningBody:   { whiteSpace: "pre-wrap", fontSize: "0.75rem", color: "#666", lineHeight: 1.4,
                     maxHeight: 200, overflowY: "auto", marginTop: 4 },
  form:       { display: "flex", gap: 6, padding: "10px 14px",
                borderTop: `1px solid ${colors.border}` },
  input:      { flex: 1, background: colors.panelAlt, border: `1px solid ${colors.borderStrong}`,
                borderRadius: 6, padding: "8px 12px", color: colors.text, fontSize: "0.85rem",
                resize: "none", outline: "none", fontFamily: "inherit" },
  sendBtn:    { background: colors.accent, border: "none", borderRadius: 6, color: "#fff",
                padding: "8px 14px", cursor: "pointer", fontSize: "0.85rem" },
  stopBtn:    { background: "#5a2a2a", border: "none", borderRadius: 6, color: "#fca5a5",
                padding: "8px 14px", cursor: "pointer", fontSize: "0.85rem" },
};
