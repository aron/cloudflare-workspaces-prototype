/**
 * The Worker uses a single model env-wide today: OpenAI when OPENAI_API_KEY
 * is set, otherwise the Workers AI Kimi default. Both the Agent DO (for
 * inference) and the App (so the UI can display the current model name)
 * read it from here.
 */

const WORKERS_AI_DEFAULT = "@cf/moonshotai/kimi-k2.6";
const OPENAI_FALLBACK    = "gpt-4o-mini";

/**
 * Context window (max input+output tokens) for the primary OpenAI model.
 * gpt-5.5 ships a 272K-token window; compaction thresholds are derived from
 * this so the agent compacts with headroom before the provider rejects an
 * over-long prompt. Workers AI fallbacks have much smaller windows, but they
 * are only used in dev/test where compaction pressure doesn't arise, so a
 * single constant keyed to the production model is enough.
 */
export const MODEL_CONTEXT_WINDOW = 272_000;

interface ModelEnv {
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?:   string;
}

/** Returns the model id that Agent.onChatMessage will pick on the next turn. */
export function currentModelId(env: ModelEnv): string {
  // `||` (not `??`) so an explicit `OPENAI_MODEL=""` still falls back.
  if (env.OPENAI_API_KEY) return env.OPENAI_MODEL || OPENAI_FALLBACK;
  return WORKERS_AI_DEFAULT;
}

/** Human-friendly label for the model — what the UI shows next to the composer. */
export function currentModelLabel(env: ModelEnv): string {
  const id = currentModelId(env);
  // Strip Workers AI's "@cf/<vendor>/" prefix for display.
  if (id.startsWith("@cf/")) {
    const tail = id.split("/").pop()!;
    return tail;
  }
  return id;
}
