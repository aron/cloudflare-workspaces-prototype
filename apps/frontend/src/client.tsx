import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { isToolUIPart, getToolName } from "ai";
import { useRef, useCallback, useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { marked } from "marked";

function generateId(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  return `agent-${hex}`;
}

function loadOrCreateId(): string {
  const stored = localStorage.getItem("sessionId");
  if (stored) return stored;
  const id = generateId();
  localStorage.setItem("sessionId", id);
  return id;
}

interface Persona {
  id:          string;
  name:        string;
  description: string;
}

interface PersonasResponse {
  personas: Persona[];
  default:  string;
}

// Force-include credentials on every same-origin fetch so the Access
// CF_Authorization cookie is sent (browsers default to `same-origin` which
// usually works, but some Access configs only inject the JWT header when
// the cookie is explicitly present).
const FETCH_OPTS: RequestInit = { credentials: "same-origin" };

async function fetchPersonas(): Promise<PersonasResponse> {
  const res = await fetch("/personas", FETCH_OPTS);
  if (!res.ok) throw new Error(`/personas → ${res.status}`);
  return res.json();
}

async function fetchCurrentPersona(sessionId: string): Promise<string | null> {
  try {
    const res = await fetch(`/debug/${sessionId}/persona`, FETCH_OPTS);
    if (!res.ok) return null;
    const data = await res.json() as { current?: { id: string } };
    return data.current?.id ?? null;
  } catch { return null; }
}

async function setSessionPersona(sessionId: string, personaId: string): Promise<void> {
  await fetch(`/debug/${sessionId}/persona`, {
    ...FETCH_OPTS,
    method:  "POST",
    headers: { "content-type": "application/json" },
    body:    JSON.stringify({ id: personaId }),
  });
}

// Minimal markdown rendering for chat bubbles. GFM tables/strikethrough/lists,
// single newlines become <br>, code blocks stay monospace. We sanitize by
// virtue of `marked` escaping HTML by default — we never set rawHtml inputs.
marked.setOptions({ gfm: true, breaks: true });
function Markdown({ text }: { text: string }) {
  const html = marked.parse(text, { async: false }) as string;
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
}

function App() {
  const [input,     setInput]     = useState("");
  const [status,    setStatus]    = useState("connecting");
  const [sessionId, setSessionId] = useState(() => loadOrCreateId());
  const [personas,  setPersonas]  = useState<Persona[]>([]);
  const [currentPersonaId, setCurrentPersonaId] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Fetch the persona registry once on mount, plus this session's current persona.
  useEffect(() => {
    fetchPersonas().then(r => setPersonas(r.personas)).catch(() => {});
  }, []);
  useEffect(() => {
    fetchCurrentPersona(sessionId).then(setCurrentPersonaId);
  }, [sessionId]);

  const startNewSession = useCallback(async (personaId: string) => {
    const id = generateId();
    // Set the persona BEFORE switching the session id so the agent DO sees
    // the right persona on its very first chat message.
    await setSessionPersona(id, personaId).catch(() => {});
    localStorage.setItem("sessionId", id);
    // Hard reload so every bit of in-memory chat state (messages, streaming
    // status, persona) is reset cleanly. The new session id is already in
    // localStorage so loadOrCreateId() picks it up on boot.
    window.location.reload();
  }, []);

  const agent = useAgent({
    agent: "agent",
    name: sessionId,
    onOpen:  useCallback(() => setStatus("connected"), []),
    onClose: useCallback(() => setStatus("disconnected"), []),
  });

  const { messages, sendMessage, isStreaming, clearHistory, stop } = useAgentChat({ agent });

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const send = useCallback(() => {
    const text = input.trim();
    if (!text || isStreaming) return;
    setInput("");
    // Official signature: { role, parts } — not { text } and not a plain string
    sendMessage({ role: "user", parts: [{ type: "text", text }] });
  }, [input, isStreaming, sendMessage]);

  const onKey = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
    },
    [send],
  );

  return (
    <div style={s.root}>
      <div style={s.header}>
        <span>⚡ Agent</span>
        <div style={s.headerRight}>
          <span style={{ ...s.dot, background: status === "connected" ? "#4ade80" : status === "connecting" ? "#facc15" : "#f87171" }} />
          <span style={s.statusText}>{status}</span>
          {/* Current persona indicator */}
          {currentPersonaId && (
            <span style={s.personaPill} title="Current persona">
              {personas.find(p => p.id === currentPersonaId)?.name ?? currentPersonaId}
            </span>
          )}
          {/* New-session dropdown: select a persona to start a fresh session. */}
          <select
            style={s.newSelect}
            value=""
            onChange={(e) => {
              const id = e.target.value;
              if (id) void startNewSession(id);
              e.currentTarget.value = "";  // reset so the same option can be picked again
            }}
            disabled={personas.length === 0}
            title="Start a new session with a persona"
          >
            <option value="">+ New session…</option>
            {personas.map(p => (
              <option key={p.id} value={p.id} title={p.description}>{p.name}</option>
            ))}
          </select>
        </div>
      </div>

      <div style={s.messages}>
        {messages.length === 0 && (
          <div style={s.empty}>Ask me to build a CLI tool — I'll compile it to WASM and run it here in the browser</div>
        )}

        {messages.map((m) => {
          if (m.role === "user") {
            const text = m.parts
              .filter((p) => p.type === "text")
              .map((p) => (p as { type: "text"; text: string }).text)
              .join("");
            return <div key={m.id} style={s.user}>{text}</div>;
          }

          if (m.role === "assistant") {
            const rendered = m.parts.map((part, i) => {
                  if (part.type === "text") {
                    return <Markdown key={i} text={part.text} />;
                  }

                  if (part.type === "reasoning") {
                    const text = (part as any).text;
                    if (!text) return null;
                    return (
                      <details key={i} style={s.reasoning} open>
                        <summary style={s.reasoningSummary}>thinking…</summary>
                        <div style={s.reasoningBody}>{text}</div>
                      </details>
                    );
                  }


                  if (isToolUIPart(part)) {
                    const name = getToolName(part);
                    const input  = (part as any).input;
                    const output = (part as any).output;
                    const error  = (part as any).errorText;
                    const running = part.state === "input-available" || part.state === "input-streaming";
                    const done    = part.state === "output-available";
                    const failed  = part.state === "output-error";

                    return (
                      <div key={i} style={s.tool}>
                        <div style={s.toolHeader}>
                          <span>{running ? "⚙" : done ? "✓" : failed ? "✗" : "⚙"}</span>
                          <strong>{name}</strong>
                          <span style={s.toolState}>{part.state}</span>
                        </div>
                        {input != null && (
                          <pre style={s.pre}>{JSON.stringify(input, null, 2)}</pre>
                        )}
                        {done && output != null && (() => {
                          const images = (output as { images?: Array<{ path: string; dataUrl: string }> })?.images;
                          // Show the raw JSON, but strip dataUrls from the preview (they're huge)
                          // and render the images separately as <img>.
                          const preview = typeof output === "object" && output !== null
                            ? { ...(output as object), images: images?.map(i => ({ path: i.path, mime: i.dataUrl.slice(5, i.dataUrl.indexOf(";")) })) }
                            : output;
                          return (
                            <>
                              <pre style={{ ...s.pre, color: "#7ec87e" }}>
                                {JSON.stringify(preview, null, 2)}
                              </pre>
                              {images?.map(img => (
                                <figure key={img.path} style={s.image}>
                                  <img src={img.dataUrl} alt={img.path} style={s.imageImg} />
                                  <figcaption style={s.imageCaption}>{img.path}</figcaption>
                                </figure>
                              ))}
                            </>
                          );
                        })()}
                        {failed && error && (
                          <pre style={{ ...s.pre, color: "#f87171" }}>{error}</pre>
                        )}
                      </div>
                    );
                  }

              return null;
            }).filter(Boolean);

            // Skip messages where every part was a step-start, empty reasoning,
            // or otherwise produced nothing — otherwise we leave orphaned shells.
            if (rendered.length === 0) return null;

            return (
              <div key={m.id} style={s.assistant}>{rendered}</div>
            );
          }

          return null;
        })}

        {isStreaming && <div style={s.thinking}>●●●</div>}
        <div ref={bottomRef} />
      </div>

      <div style={s.form}>
        <textarea
          style={s.input}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKey}
          placeholder="e.g. build a CLI tool that counts words in stdin…"
          rows={2}
          disabled={status !== "connected"}
        />
        {isStreaming
          ? <button style={s.stopBtn} onClick={stop}>Stop</button>
          : <button style={s.sendBtn} onClick={send} disabled={status !== "connected" || !input.trim()}>Send</button>
        }
      </div>
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  root:       { display: "flex", flexDirection: "column", height: "100dvh", maxWidth: 860, margin: "0 auto", padding: "0 16px", fontFamily: "system-ui, sans-serif", background: "#0f0f0f", color: "#e0e0e0" },
  header:     { display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "1.05rem", fontWeight: 600, padding: "14px 0 12px", borderBottom: "1px solid #222", color: "#fff" },
  headerRight:{ display: "flex", alignItems: "center", gap: 8 },
  dot:        { width: 8, height: 8, borderRadius: "50%", display: "inline-block" },
  statusText: { fontSize: "0.75rem", color: "#888" },
  clearBtn:   { background: "none", border: "1px solid #333", borderRadius: 4, color: "#888", padding: "3px 8px", cursor: "pointer", fontSize: "0.75rem" },
  personaPill:{ background: "#1a2a3a", color: "#9fc1ed", border: "1px solid #2a3a4a", borderRadius: 999, padding: "2px 8px", fontSize: "0.7rem", fontWeight: 500 },
  newSelect:  { background: "#1a1a1a", border: "1px solid #333", borderRadius: 4, color: "#ccc", padding: "3px 8px", cursor: "pointer", fontSize: "0.75rem", outline: "none" },
  messages:   { flex: 1, overflowY: "auto", padding: "16px 0", display: "flex", flexDirection: "column", gap: 10 },
  empty:      { color: "#555", textAlign: "center", marginTop: 40, fontSize: "0.9rem" },
  user:       { background: "#1a3a5c", padding: "10px 14px", borderRadius: 8, alignSelf: "flex-end", maxWidth: "85%", whiteSpace: "pre-wrap", fontSize: "0.88rem", lineHeight: 1.55 },
  assistant:  { background: "#1e1e1e", border: "1px solid #2a2a2a", padding: "10px 14px", borderRadius: 8, alignSelf: "flex-start", maxWidth: "92%", fontSize: "0.88rem", lineHeight: 1.6, display: "flex", flexDirection: "column", gap: 6 },
  tool:       { background: "#111811", border: "1px solid #2a3a2a", padding: "8px 10px", borderRadius: 6, fontSize: "0.78rem" },
  toolHeader: { display: "flex", alignItems: "center", gap: 6, marginBottom: 4 },
  toolState:  { color: "#555", fontSize: "0.72rem", marginLeft: "auto" },
  pre:        { margin: "2px 0 0", fontFamily: "monospace", fontSize: "0.76rem", lineHeight: 1.4 as const, overflowX: "auto", overflowY: "auto" as const, maxHeight: "calc(0.76rem * 1.4 * 8)", color: "#888", whiteSpace: "pre-wrap", wordBreak: "break-all" },
  thinking:   { color: "#444", fontSize: "1.2rem", letterSpacing: 4, paddingLeft: 4 },
  reasoning:       { background: "#111", border: "1px solid #2a2a2a", borderRadius: 4, padding: "6px 10px", margin: "2px 0", fontSize: "0.8rem" },
  reasoningSummary:{ color: "#555", cursor: "pointer", userSelect: "none" as const },
  reasoningBody:   { whiteSpace: "pre-wrap" as const, fontSize: "0.78rem", color: "#666", lineHeight: 1.4, maxHeight: "calc(0.78rem * 1.4 * 8)", overflowY: "auto" as const, marginTop: 4 },
  image:        { margin: "8px 0 4px", display: "flex", flexDirection: "column" as const, gap: 4 },
  imageImg:     { maxWidth: "100%", maxHeight: 480, borderRadius: 4, border: "1px solid #222", display: "block" },
  imageCaption: { color: "#666", fontSize: "0.72rem" },
  form:       { display: "flex", gap: 8, padding: "12px 0 20px", borderTop: "1px solid #222" },
  input:      { flex: 1, background: "#1a1a1a", border: "1px solid #333", borderRadius: 6, padding: "10px 14px", color: "#e0e0e0", fontSize: "0.9rem", resize: "none", outline: "none" },
  sendBtn:    { background: "#2a5298", border: "none", borderRadius: 6, color: "#fff", padding: "10px 20px", cursor: "pointer", fontSize: "0.9rem" },
  stopBtn:    { background: "#5a2a2a", border: "none", borderRadius: 6, color: "#fca5a5", padding: "10px 20px", cursor: "pointer", fontSize: "0.9rem" },
};

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
