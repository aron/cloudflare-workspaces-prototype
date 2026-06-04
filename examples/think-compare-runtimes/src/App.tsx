import { Badge } from "@cloudflare/kumo/components/badge";
import { Button } from "@cloudflare/kumo/components/button";
import { Surface } from "@cloudflare/kumo/components/surface";
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

const runtimeCopy: Record<
  RuntimeId,
  {
    label: string;
    eyebrow: string;
    accent: string;
    badgeVariant: "teal" | "purple";
    border: string;
  }
> = {
  workspace: {
    label: "Workspace",
    eyebrow: "DOFS-first runtime",
    accent: "text-kumo-badge-teal-subtle",
    badgeVariant: "teal",
    border: "before:bg-kumo-badge-teal",
  },
  sandbox: {
    label: "Sandbox",
    eyebrow: "Container-first runtime",
    accent: "text-kumo-badge-purple",
    badgeVariant: "purple",
    border: "before:bg-kumo-badge-purple",
  },
};

const startStateVariant: Record<StartState, "neutral" | "warning" | "success" | "error"> = {
  idle: "neutral",
  starting: "warning",
  running: "success",
  failed: "error",
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
    <main className="mx-auto min-h-screen w-full max-w-[1440px] px-6 py-8 text-kumo-default sm:px-10 lg:px-18 lg:py-16">
      <section
        className="grid items-end gap-8 pb-10 lg:grid-cols-[minmax(0,1fr)_minmax(280px,380px)] lg:gap-14 lg:pb-18"
        aria-labelledby="page-title"
      >
        <div>
          <Badge variant="beta" className="mb-5">
            Think × runtime comparison
          </Badge>
          <h1
            id="page-title"
            className="max-w-5xl text-[clamp(4rem,11vw,10.5rem)] leading-[0.78] font-semibold tracking-[-0.08em] text-balance text-kumo-default"
          >
            Same agent. Same task. Different substrate.
          </h1>
          <p className="mt-8 max-w-3xl text-lg leading-8 text-kumo-subtle">
            A strict Think-vs-Think harness that makes transcript, tool, and runtime behavior
            visible while the Workspace and Sandbox agents run side by side.
          </p>
          <Surface className="mt-6 max-w-3xl rounded-2xl border border-kumo-hairline bg-kumo-base/70 p-4 shadow-sm backdrop-blur">
            <span className="font-mono text-xs tracking-[0.18em] text-kumo-subtle uppercase">
              Fixture task
            </span>
            <p className="mt-2 leading-6 text-kumo-default">{comparisonFixture.task}</p>
          </Surface>
        </div>

        <Surface className="grid gap-4 rounded-2xl border border-kumo-hairline bg-kumo-base p-5 shadow-2xl shadow-black/25 lg:-rotate-1">
          <div className="flex items-center justify-between gap-3">
            <span className="font-mono text-xs tracking-[0.18em] text-kumo-subtle uppercase">
              Run state
            </span>
            <Badge variant={startStateVariant[startState]} appearance="dot">
              {startState}
            </Badge>
          </div>
          <strong className="text-3xl font-semibold capitalize text-kumo-default">
            {startState}
          </strong>
          <Button
            className="w-full justify-center"
            disabled={startState === "starting"}
            onClick={startRun}
            type="button"
            variant="primary"
          >
            {runId ? "Restart comparison" : "Start comparison"}
          </Button>
          {runId ? (
            <code className="truncate border-t border-kumo-hairline pt-3 font-mono text-xs text-kumo-subtle">
              {runId}
            </code>
          ) : null}
          {error ? <p className="text-sm text-kumo-danger">{error}</p> : null}
        </Surface>
      </section>

      <section className="grid gap-6 lg:grid-cols-2" aria-label="Runtime timelines">
        <RuntimePanel runtime="workspace" events={eventsByRuntime.workspace} />
        <RuntimePanel runtime="sandbox" events={eventsByRuntime.sandbox} />
      </section>
    </main>
  );
}

function RuntimePanel({ runtime, events }: { runtime: RuntimeId; events: RunEvent[] }) {
  const copy = runtimeCopy[runtime];

  return (
    <Surface className="min-h-[560px] rounded-3xl border border-kumo-hairline bg-kumo-base/65 p-5 shadow-xl shadow-black/15 backdrop-blur md:p-7">
      <header className="flex items-end justify-between gap-4 border-b border-kumo-hairline pb-5">
        <h2 className="text-3xl font-semibold tracking-[-0.06em] text-kumo-default">
          {copy.label}
        </h2>
        <Badge variant={copy.badgeVariant} className="shrink-0">
          {copy.eyebrow}
        </Badge>
      </header>
      <ol className="grid gap-4 pt-6">
        {events.length === 0 ? (
          <li className="rounded-2xl border border-dashed border-kumo-hairline bg-kumo-fill/30 p-5">
            <p className="text-kumo-subtle">Start a run to stream runtime events.</p>
          </li>
        ) : (
          events.map((event) => (
            <li
              className={`relative overflow-hidden rounded-2xl border border-kumo-hairline bg-kumo-canvas/70 p-5 pl-7 before:absolute before:inset-y-0 before:left-0 before:w-1.5 ${copy.border}`}
              key={event.id}
            >
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={event.runtime === "both" ? "neutral" : copy.badgeVariant}>
                  {event.runtime}
                </Badge>
                <span className="font-mono text-xs tracking-[0.18em] text-kumo-subtle uppercase">
                  {event.kind.replaceAll("_", " ")}
                </span>
              </div>
              <strong className={`mt-3 block font-semibold ${copy.accent}`}>{event.title}</strong>
              <p className="mt-2 leading-6 text-kumo-subtle">{event.detail}</p>
            </li>
          ))
        )}
      </ol>
    </Surface>
  );
}
