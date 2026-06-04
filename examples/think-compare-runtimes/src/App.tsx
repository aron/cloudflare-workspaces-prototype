import { Badge } from "@cloudflare/kumo/components/badge";
import { Button } from "@cloudflare/kumo/components/button";
import { Surface } from "@cloudflare/kumo/components/surface";
import { usePartySocket } from "partysocket/react";
import { useMemo, useState } from "react";
import type { RunEvent, RuntimeId } from "../shared/events";
import { comparisonFixture } from "../shared/fixture";
import { agentEventsForRuntime, formatEventDetail, runtimeEventsForRuntime } from "./event-lanes";
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

  const lanesByRuntime = useMemo(
    () => ({
      workspace: {
        agent: agentEventsForRuntime(events, "workspace"),
        runtime: runtimeEventsForRuntime(events, "workspace"),
      },
      sandbox: {
        agent: agentEventsForRuntime(events, "sandbox"),
        runtime: runtimeEventsForRuntime(events, "sandbox"),
      },
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
        <RuntimePanel runtime="workspace" lanes={lanesByRuntime.workspace} />
        <RuntimePanel runtime="sandbox" lanes={lanesByRuntime.sandbox} />
      </section>
    </main>
  );
}

function RuntimePanel({
  runtime,
  lanes,
}: {
  runtime: RuntimeId;
  lanes: { agent: RunEvent[]; runtime: RunEvent[] };
}) {
  const copy = runtimeCopy[runtime];

  return (
    <Surface
      aria-label={`${copy.label} timeline`}
      className="min-h-[640px] rounded-3xl border border-kumo-hairline bg-kumo-base/65 p-5 shadow-xl shadow-black/15 backdrop-blur md:p-7"
    >
      <header className="flex items-end justify-between gap-4 border-b border-kumo-hairline pb-5">
        <div>
          <span className="font-mono text-xs tracking-[0.18em] text-kumo-subtle uppercase">
            Runtime lane
          </span>
          <h2 className="mt-2 text-3xl font-semibold tracking-[-0.06em] text-kumo-default">
            {copy.label}
          </h2>
        </div>
        <Badge variant={copy.badgeVariant} className="shrink-0">
          {copy.eyebrow}
        </Badge>
      </header>
      <div className="grid gap-5 pt-6 xl:grid-cols-[minmax(0,1.08fr)_minmax(0,0.92fr)]">
        <EventLane
          accent={copy.accent}
          border={copy.border}
          empty="Waiting for Think messages and tool calls."
          events={lanes.agent}
          runtime={runtime}
          title="Think transcript"
        />
        <EventLane
          accent={copy.accent}
          border={copy.border}
          empty="Runtime operations will appear here."
          events={lanes.runtime}
          runtime={runtime}
          title="Runtime trace"
        />
      </div>
    </Surface>
  );
}

function EventLane({
  accent,
  border,
  empty,
  events,
  runtime,
  title,
}: {
  accent: string;
  border: string;
  empty: string;
  events: RunEvent[];
  runtime: RuntimeId;
  title: string;
}) {
  return (
    <section className="rounded-2xl border border-kumo-hairline bg-kumo-canvas/45 p-3">
      <header className="flex items-center justify-between gap-3 px-2 py-1">
        <h3 className="text-lg font-semibold tracking-[-0.03em] text-kumo-default">{title}</h3>
        <span className="font-mono text-[0.65rem] tracking-[0.16em] text-kumo-subtle uppercase">
          {events.length} events
        </span>
      </header>
      <ol className="mt-3 grid gap-3">
        {events.length === 0 ? (
          <li className="rounded-xl border border-dashed border-kumo-hairline bg-kumo-fill/30 p-4">
            <p className="text-sm leading-6 text-kumo-subtle">{empty}</p>
          </li>
        ) : (
          events.map((event) => (
            <EventCard
              accent={accent}
              border={border}
              event={event}
              key={event.id}
              runtime={runtime}
            />
          ))
        )}
      </ol>
    </section>
  );
}

function EventCard({
  accent,
  border,
  event,
  runtime,
}: {
  accent: string;
  border: string;
  event: RunEvent;
  runtime: RuntimeId;
}) {
  return (
    <li
      className={`relative overflow-hidden rounded-2xl border border-kumo-hairline bg-kumo-base/75 p-4 pl-6 before:absolute before:inset-y-0 before:left-0 before:w-1 ${border}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={event.runtime === "both" ? "neutral" : runtimeCopy[runtime].badgeVariant}>
          {event.runtime}
        </Badge>
        <span className="font-mono text-[0.65rem] tracking-[0.18em] text-kumo-subtle uppercase">
          {event.kind.replaceAll("_", " ")}
        </span>
      </div>
      <strong className={`mt-3 block text-sm font-semibold ${accent}`}>{event.title}</strong>
      <EventDetail detail={event.detail} />
    </li>
  );
}

function EventDetail({ detail }: { detail: string }) {
  const formatted = formatEventDetail(detail);

  if (formatted.fields.length === 0) {
    return <p className="mt-2 text-sm leading-6 text-kumo-subtle">{formatted.text}</p>;
  }

  return (
    <dl className="mt-3 grid gap-2">
      {formatted.fields.map((field) => (
        <div
          className="rounded-xl border border-kumo-hairline bg-kumo-fill/35 p-3"
          key={field.label}
        >
          <dt className="font-mono text-[0.64rem] tracking-[0.16em] text-kumo-subtle uppercase">
            {field.label}
          </dt>
          <dd className="mt-1 overflow-x-auto font-mono text-xs leading-5 whitespace-pre-wrap text-kumo-default">
            {field.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
