import { usePartySocket } from "partysocket/react";
import { useMemo, useState } from "react";
import type { RunEvent, RuntimeId } from "../shared/events";
import { comparisonFixture } from "../shared/fixture";
import { applyRunMessage, type RunMessage } from "./run-state";

interface RunSessionResponse {
  runId: string;
  socketPath: string;
  events: RunEvent[];
}

type StartState = "idle" | "starting" | "running" | "failed";

const runtimeCopy: Record<RuntimeId, { label: string; eyebrow: string }> = {
  workspace: {
    label: "Workspace",
    eyebrow: "DOFS-first runtime",
  },
  sandbox: {
    label: "Sandbox",
    eyebrow: "Container-first runtime",
  },
};

export function App() {
  const [runId, setRunId] = useState<string | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [startState, setStartState] = useState<StartState>("idle");
  const [error, setError] = useState<string | null>(null);

  usePartySocket({
    party: "compare-run",
    room: runId ?? "idle",
    enabled: runId !== null,
    onMessage(message) {
      const parsed = JSON.parse(String(message.data)) as RunMessage;
      setEvents((current) => applyRunMessage(current, parsed));
    },
  });

  const eventsByRuntime = useMemo(
    () => ({
      workspace: events.filter(
        (event) => event.runtime === "workspace" || event.runtime === "both",
      ),
      sandbox: events.filter((event) => event.runtime === "sandbox" || event.runtime === "both"),
    }),
    [events],
  );

  async function startRun() {
    setStartState("starting");
    setError(null);

    try {
      const response = await fetch("/api/runs", { method: "POST" });

      if (!response.ok) {
        throw new Error(`Run request failed with ${response.status}`);
      }

      const session = (await response.json()) as RunSessionResponse;
      setRunId(session.runId);
      setEvents(session.events);
      setStartState("running");
    } catch (cause) {
      setStartState("failed");
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return (
    <main className="shell">
      <section className="hero" aria-labelledby="page-title">
        <div>
          <p className="kicker">Think × runtime comparison</p>
          <h1 id="page-title">Same agent. Same task. Different substrate.</h1>
          <p className="lede">
            A strict Think-vs-Think harness that makes transcript, tool, and runtime behavior
            visible while the Workspace and Sandbox agents run side by side.
          </p>
          <p className="task-card">
            <span>Fixture task</span>
            {comparisonFixture.task}
          </p>
        </div>
        <div className="control-card">
          <span className="control-label">Run state</span>
          <strong>{startState}</strong>
          <button
            className="start-button"
            disabled={startState === "starting"}
            onClick={startRun}
            type="button"
          >
            {runId ? "Restart comparison" : "Start comparison"}
          </button>
          {runId ? <code>{runId}</code> : null}
          {error ? <p className="error">{error}</p> : null}
        </div>
      </section>

      <section className="panels" aria-label="Runtime timelines">
        <RuntimePanel runtime="workspace" events={eventsByRuntime.workspace} />
        <RuntimePanel runtime="sandbox" events={eventsByRuntime.sandbox} />
      </section>
    </main>
  );
}

function RuntimePanel({ runtime, events }: { runtime: RuntimeId; events: RunEvent[] }) {
  const copy = runtimeCopy[runtime];

  return (
    <article className={`panel panel-${runtime}`}>
      <header>
        <p>{copy.eyebrow}</p>
        <h2>{copy.label}</h2>
      </header>
      <ol className="timeline">
        {events.length === 0 ? (
          <li className="empty">Start a run to stream runtime events.</li>
        ) : (
          events.map((event) => (
            <li className={`event event-${event.kind}`} key={event.id}>
              <span>{event.kind.replaceAll("_", " ")}</span>
              <strong>{event.title}</strong>
              <p>{event.detail}</p>
            </li>
          ))
        )}
      </ol>
    </article>
  );
}
