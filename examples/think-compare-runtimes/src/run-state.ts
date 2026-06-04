import type { RunEvent } from "../shared/events";

export type RunMessage =
  | {
      type: "history";
      events: RunEvent[];
    }
  | {
      type: "event";
      event: RunEvent;
    };

export function applyRunMessage(events: RunEvent[], message: RunMessage): RunEvent[] {
  if (message.type === "history") {
    return [...message.events].sort(bySequence);
  }

  return [...events, message.event].sort(bySequence);
}

function bySequence(left: RunEvent, right: RunEvent): number {
  return left.sequence - right.sequence;
}
