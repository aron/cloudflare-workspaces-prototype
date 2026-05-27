/**
 * LoopTracker — per-turn budget and duplicate-call detector.
 *
 * Think's built-in `maxSteps` is a flat count of model round-trips. That
 * conflates cheap exploration (read/grep/find) with real mutation work
 * (edit/exec). A research-heavy turn can legitimately read 20 files
 * before acting; a flat counter would punish that.
 *
 * This tracker:
 *   1. Counts only **mutating** tool calls against a soft budget.
 *   2. Watches a rolling window of (tool, input) keys and flags loops
 *      when the same exact call repeats `loopThreshold` times.
 *
 * Either trigger fires a reflection — an injected user message asking
 * the agent to check whether it's stuck. The reflection limit guards
 * against reflect→hit-budget-again→reflect cycles.
 *
 * Pure data structure: no Cloudflare bindings, no async, no Durable
 * Object state. Wire it up from Agent's `onStepFinish` / `onChatResponse`
 * / `beforeTurn` hooks.
 */

export interface ToolCallRecord {
  toolName: string;
  input: unknown;
}

export interface LoopTrackerConfig {
  /** Tools whose calls don't count against the mutation budget. */
  readOnlyTools: ReadonlySet<string>;
  /** Mutation-equivalent steps before a budget reflection fires. */
  reflectionBudget: number;
  /** Rolling window size for loop detection (in tool calls). */
  loopWindow: number;
  /** Identical-call repeats within the window that count as a loop. */
  loopThreshold: number;
  /** Max reflections to fire per logical turn. Defaults to 1. */
  maxReflectionsPerTurn?: number;
}

export type ReflectionDecision =
  | { kind: "budget"; spent: number; budget: number }
  | { kind: "loop"; toolName: string; count: number; key: string };

export class LoopTracker {
  private readonly cfg: Required<LoopTrackerConfig>;
  private _spent = 0;
  private _recent: string[] = [];
  private _reflections = 0;

  constructor(cfg: LoopTrackerConfig) {
    this.cfg = {
      maxReflectionsPerTurn: 1,
      ...cfg,
    };
  }

  get spent(): number { return this._spent; }
  get reflectionsFired(): number { return this._reflections; }

  /** Record one model step. Pure-text steps (no tool calls) cost 1. */
  recordStep(calls: readonly ToolCallRecord[]): void {
    if (calls.length === 0) {
      this._spent += 1;
      return;
    }
    let cost = 0;
    for (const c of calls) {
      if (!this.cfg.readOnlyTools.has(c.toolName)) cost += 1;
      this._recent.push(this.callKey(c));
    }
    this._spent += cost;

    if (this._recent.length > this.cfg.loopWindow) {
      this._recent = this._recent.slice(-this.cfg.loopWindow);
    }
  }

  /** Returns a decision when a reflection should fire, else null. */
  shouldReflect(): ReflectionDecision | null {
    if (this._reflections >= this.cfg.maxReflectionsPerTurn) return null;

    const loop = this.detectLoop();
    if (loop) return loop;

    if (this._spent >= this.cfg.reflectionBudget) {
      return {
        kind: "budget",
        spent: this._spent,
        budget: this.cfg.reflectionBudget,
      };
    }
    return null;
  }

  /** Caller must call this after persisting the reflection message so the
   *  guard counter advances and we don't loop on reflections themselves. */
  markReflected(): void {
    this._reflections += 1;
  }

  /** Clear all per-turn state. Call at the start of a fresh user turn. */
  reset(): void {
    this._spent = 0;
    this._recent = [];
    this._reflections = 0;
  }

  /** Render the user-facing reflection message text. */
  buildReflectionMessage(decision: ReflectionDecision): string {
    const reason = decision.kind === "loop"
      ? `You appear to be repeating the same tool call (${decision.toolName}, ${decision.count}× with identical input).`
      : `You have used ${decision.spent} mutation-equivalent steps on this turn (soft budget: ${decision.budget}).`;
    return [
      reason,
      "",
      "Before continuing, take one breath and answer:",
      "",
      "1. **Goal.** What is the user's original request, in one sentence?",
      "2. **Progress.** What concrete, verifiable progress have you made?",
      "3. **Stuck?** Are you re-running the same tool with similar inputs, or retrying after the same error? If yes — you are stuck. Change strategy: try a different tool, ask the user a clarifying question, or stop and report what you found.",
      "4. **Next.** If you are making real progress, state the next 1–2 steps and continue. Otherwise, summarise what you have and hand back to the user.",
    ].join("\n");
  }

  // ── internals ──────────────────────────────────────────────────

  private callKey(c: ToolCallRecord): string {
    let inputKey: string;
    try {
      inputKey = JSON.stringify(c.input);
    } catch {
      // Circular refs or BigInts land here. Use a stable fallback so
      // identical unserializable inputs still collide into one key,
      // catching loops on weird inputs instead of silently ignoring them.
      inputKey = "<unserializable>";
    }
    return `${c.toolName}:${inputKey}`;
  }

  private detectLoop(): ReflectionDecision | null {
    const counts = new Map<string, number>();
    for (const k of this._recent) {
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    let worst: { key: string; count: number } | null = null;
    for (const [key, count] of counts) {
      if (count >= this.cfg.loopThreshold && (!worst || count > worst.count)) {
        worst = { key, count };
      }
    }
    if (!worst) return null;
    const colon = worst.key.indexOf(":");
    const toolName = colon === -1 ? worst.key : worst.key.slice(0, colon);
    return { kind: "loop", toolName, count: worst.count, key: worst.key };
  }
}
