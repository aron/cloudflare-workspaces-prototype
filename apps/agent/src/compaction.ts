/**
 * Auto-compaction wiring for the Agent's Session.
 *
 * The Session package (`agents/experimental/memory/session`) already ships the
 * full compaction machinery — boundary selection, tool-pair alignment,
 * iterative summaries, non-destructive overlays. All the app supplies is:
 *
 *   1. HOW to summarize — an LLM call (`createCompactFunction({ summarize })`).
 *   2. WHEN to compact — a token threshold (`session.compactAfter(...)`).
 *
 * We wrap the reference compaction function in a trace span so every compaction
 * shows up under `agent.compaction` in the Workers Observability traces, with
 * before/after token estimates, the compacted id range, and the summary size.
 * A nested `agent.compaction.summarize` span isolates the LLM round-trip.
 *
 * Thresholds are derived from the model context window (see `model.ts`). With
 * gpt-5.5's 272K window:
 *   - compactAfter fires between turns at ~80% (leaves room for one more turn
 *     to grow before the next check).
 *   - the proactive guard (configured in agent.ts) fires mid-turn at 90%.
 *   - the reactive backstop catches a genuine provider overflow.
 */
import {
  createCompactFunction,
  estimateMessageTokens,
} from "agents/experimental/memory/utils";
import type { CompactResult } from "agents/experimental/memory/utils";
import type { SessionMessage } from "agents/experimental/memory/session";
import { generateText } from "ai";
import type { LanguageModel } from "ai";

/**
 * The context object the Session passes to a compaction function (carries the
 * Session's token counter). `CompactContext` isn't re-exported from the public
 * entrypoints, so we recover it from the reference function's signature to stay
 * exactly in sync with the installed package version.
 */
type CompactContext = NonNullable<
  Parameters<ReturnType<typeof createCompactFunction>>[1]
>;
import { trace } from "./tracing.js";
import { MODEL_CONTEXT_WINDOW } from "./model.js";

/**
 * Fraction of the context window at which the between-turns auto-compaction
 * check fires. Checked after each `appendMessage`, so this leaves ~20% of the
 * window as headroom for the turn that pushes history over the line plus the
 * next model response before the following check.
 */
export const COMPACT_AFTER_FRACTION = 0.8;

/**
 * Fraction of the context window at which the proactive in-turn guard compacts.
 * Higher than {@link COMPACT_AFTER_FRACTION} because it keys off the previous
 * step's model-reported `usage.inputTokens` — a precise, already-happened
 * number — so it can afford to run closer to the limit.
 */
export const PROACTIVE_HEADROOM = 0.9;

/** Auto-compaction threshold in tokens for `session.compactAfter(...)`. */
export const COMPACT_AFTER_TOKENS = Math.floor(
  MODEL_CONTEXT_WINDOW * COMPACT_AFTER_FRACTION,
);

/** Max input tokens the proactive guard targets (the full window). */
export const PROACTIVE_MAX_INPUT_TOKENS = MODEL_CONTEXT_WINDOW;

export interface CompactionDeps {
  /**
   * Resolver for the model used to produce the summary. A thunk (not the model
   * itself) so it is only constructed when a compaction actually runs —
   * `configureSession` executes at `onStart`, before any turn, and eagerly
   * building the model there would crash environments without a provider
   * binding (e.g. the agent-suite tests that have no AI binding). Reuse the
   * chat model.
   */
  model: () => LanguageModel;
  /** Thread id, attached to spans for grouping. */
  threadId: string;
}

/**
 * Build a compaction function wrapped in tracing.
 *
 * The returned function has the same signature the Session expects from
 * `onCompaction(fn)`. It is only invoked when the Session decides history is
 * over threshold, so an `agent.compaction` span appears exactly once per real
 * compaction attempt — including the no-op case (returns `null`), which is
 * still worth seeing in traces because it explains why history didn't shrink.
 */
export function createTracedCompaction(deps: CompactionDeps) {
  const { model, threadId } = deps;

  // The reference implementation from the Session package. `summarize` is the
  // only app-owned piece; we wrap it in a child span so the LLM latency and
  // output size are attributable separately from the boundary bookkeeping.
  const compact = createCompactFunction({
    summarize: (prompt: string) =>
      trace(
        "agent.compaction.summarize",
        { "hackspace.thread_id": threadId },
        async (span) => {
          span.set("hackspace.compaction.prompt_chars", () => prompt.length);
          const { text, usage } = await generateText({ model: model(), prompt });
          span.set(
            "hackspace.compaction.summary_chars",
            () => text.length,
          );
          span.set(
            "hackspace.compaction.summary_tokens",
            () => usage?.outputTokens ?? 0,
          );
          return text;
        },
      ),
    // Keep the first 3 messages (system framing / originating request) and a
    // ~20K-token recent tail intact; summarize the middle. These are the
    // package defaults, pinned explicitly so the behavior is visible here.
    protectHead: 3,
    tailTokenBudget: 20_000,
    minTailMessages: 2,
  });

  return (
    messages: SessionMessage[],
    context?: CompactContext,
  ): Promise<CompactResult | null> =>
    trace(
      "agent.compaction",
      { "hackspace.thread_id": threadId },
      async (span) => {
        span.set("hackspace.compaction.messages", () => messages.length);
        span.set("hackspace.compaction.tokens_before", () =>
          estimateMessageTokens(messages),
        );

        const result = await compact(messages, context);

        span.set("hackspace.compaction.compacted", () => result != null);
        if (result) {
          span.set(
            "hackspace.compaction.summary_chars",
            () => result.summary.length,
          );
          span.set(
            "hackspace.compaction.from_id",
            () => result.fromMessageId,
          );
          span.set("hackspace.compaction.to_id", () => result.toMessageId);
        }
        return result;
      },
    );
}
