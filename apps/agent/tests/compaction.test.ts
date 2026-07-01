/**
 * Tests for the Session auto-compaction wiring in `compaction.ts`.
 *
 * Two things matter here:
 *
 *   1. The token thresholds are derived from the model context window the way
 *      we expect. These feed `session.compactAfter()` and the `contextOverflow`
 *      proactive guard, so a regression silently changes when the agent
 *      compacts — pin the arithmetic.
 *
 *   2. `createTracedCompaction` returns a function with the Session's
 *      `onCompaction` shape that actually drives the model to produce a summary
 *      and reports a `CompactResult` over the compacted range. Tracing itself
 *      is a no-op outside workerd's `cloudflare:workers` binding, so the span
 *      wrapper must be transparent to the return value.
 */
import { describe, it, expect } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import {
  COMPACT_AFTER_FRACTION,
  COMPACT_AFTER_TOKENS,
  PROACTIVE_HEADROOM,
  PROACTIVE_MAX_INPUT_TOKENS,
  createTracedCompaction,
} from "../src/compaction.js";
import { MODEL_CONTEXT_WINDOW } from "../src/model.js";

/** A message with enough text that the middle survives boundary trimming. */
function msg(id: string, role: string, text: string) {
  return { id, role, parts: [{ type: "text", text }] };
}

/** Mock model that returns a fixed summary and records the prompt it saw. */
function summaryModel(summary: string) {
  const prompts: string[] = [];
  const model = new MockLanguageModelV3({
    modelId: "mock-summarizer",
    doGenerate: async (options) => {
      // The prompt's last user message carries the summarization request.
      prompts.push(JSON.stringify(options.prompt));
      return {
        content: [{ type: "text", text: summary }],
        finishReason: { unified: "stop", raw: undefined },
        usage: {
          inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 20, text: 20, reasoning: 0 },
        },
        warnings: [],
      };
    },
  });
  return { model, prompts };
}

describe("compaction thresholds", () => {
  it("derives compactAfter at 80% of the model window", () => {
    expect(COMPACT_AFTER_FRACTION).toBe(0.8);
    expect(COMPACT_AFTER_TOKENS).toBe(
      Math.floor(MODEL_CONTEXT_WINDOW * 0.8),
    );
    // gpt-5.5: 272_000 * 0.8 = 217_600.
    expect(COMPACT_AFTER_TOKENS).toBe(217_600);
  });

  it("targets the full window for the proactive guard at 90% headroom", () => {
    expect(PROACTIVE_MAX_INPUT_TOKENS).toBe(MODEL_CONTEXT_WINDOW);
    expect(PROACTIVE_HEADROOM).toBe(0.9);
    // Effective proactive trip point: 272_000 * 0.9 = 244_800.
    expect(PROACTIVE_MAX_INPUT_TOKENS * PROACTIVE_HEADROOM).toBe(244_800);
  });

  it("keeps compactAfter below the proactive trip point", () => {
    // Between-turns compaction should fire before the mid-turn guard, so a
    // normal conversation compacts at turn boundaries and the guard is only a
    // backstop for a single runaway turn.
    expect(COMPACT_AFTER_TOKENS).toBeLessThan(
      PROACTIVE_MAX_INPUT_TOKENS * PROACTIVE_HEADROOM,
    );
  });
});

describe("createTracedCompaction", () => {
  it("summarizes the middle and returns a CompactResult over the range", async () => {
    const { model, prompts } = summaryModel("## Topic\nCompacted summary.");
    const fn = createTracedCompaction({ model: () => model, threadId: "thread-1" });

    // protectHead=3, minTailMessages=2, tailTokenBudget=20K. Each message is
    // ~10K tokens (~40K chars) so the tail budget only covers ~2 messages and
    // a compressible middle remains between the head and tail.
    const big = (c: string) => c.repeat(40_000);
    const messages = [
      msg("m1", "user", "first request " + big("x")),
      msg("m2", "assistant", "answer one " + big("y")),
      msg("m3", "user", "second " + big("z")),
      msg("m4", "assistant", "answer two " + big("a")),
      msg("m5", "user", "third " + big("b")),
      msg("m6", "assistant", "answer three " + big("c")),
      msg("m7", "user", "fourth " + big("d")),
      msg("m8", "assistant", "answer four " + big("e")),
    ];

    const result = await fn(messages);

    expect(result).not.toBeNull();
    expect(result?.summary).toContain("Compacted summary.");
    // The compacted range starts after the protected head and ends before the
    // protected tail — never the very first or very last message.
    expect(result?.fromMessageId).not.toBe("m1");
    expect(result?.toMessageId).not.toBe("m8");
    // The model was actually asked to summarize.
    expect(prompts.length).toBe(1);
  });

  it("returns null when history is too short to compact", async () => {
    const { model, prompts } = summaryModel("unused");
    const fn = createTracedCompaction({ model: () => model, threadId: "thread-2" });

    // <= protectHead + minTailMessages → nothing to compact.
    const messages = [
      msg("m1", "user", "hi"),
      msg("m2", "assistant", "hello"),
      msg("m3", "user", "bye"),
    ];

    const result = await fn(messages);
    expect(result).toBeNull();
    // No summary call when there's nothing to summarize.
    expect(prompts.length).toBe(0);
  });
});
