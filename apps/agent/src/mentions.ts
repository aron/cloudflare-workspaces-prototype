/**
 * Pure helpers for parsing `@persona` mentions out of room/thread messages
 * and deciding which persona should respond on a given turn.
 *
 * Lives outside `room-do.ts` and `agent.ts` so both can share the same
 * matching rules — and so we can unit-test it without spinning up DOs.
 */

import { PERSONAS } from "./personas/index.js";

const VALID_PERSONA_IDS: ReadonlySet<string> = new Set(PERSONAS.map(p => p.id));

/**
 * Find every `@persona` mention in `text` that refers to a known persona.
 * Returned ids are in document order. Duplicates are de-duped, first wins.
 */
export function extractMentions(text: string): string[] {
  const re = /@([a-z0-9][a-z0-9_-]{0,63})/gi;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of text.matchAll(re)) {
    const id = m[1]?.toLowerCase();
    if (id && VALID_PERSONA_IDS.has(id) && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/** Returns the first valid mention, or null. Convenience for room messages. */
export function firstMention(text: string): string | null {
  return extractMentions(text)[0] ?? null;
}

/** Minimal shape we need from a chat message to do mention resolution. */
export interface MentionableMessage {
  role:  "user" | "assistant" | string;
  parts: Array<{ type: string; text?: string }>;
}

/**
 * Decide which persona should respond to the next turn in a thread.
 *
 * Rules (product spec):
 *   - "last @-mentioned wins for this turn"
 *   - falls back to `defaultPersonaId` (the thread's original responder)
 *     when no recent user message mentions a known persona.
 *
 * Scans messages from newest to oldest, stopping at the first user message
 * with a valid mention. Assistant messages are ignored — only what the
 * humans explicitly direct counts.
 */
export function resolvePersonaForTurn(
  messages: readonly MentionableMessage[],
  defaultPersonaId: string,
): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.role !== "user") continue;
    const text = msg.parts
      .filter(p => p.type === "text" && typeof p.text === "string")
      .map(p => p.text as string)
      .join(" ");
    const mention = firstMention(text);
    if (mention) return mention;
  }
  return defaultPersonaId;
}
