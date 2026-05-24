/**
 * The Worker uses a single model env-wide today: OpenAI when OPENAI_API_KEY
 * is set, otherwise the Workers AI Kimi default. Both the Agent DO (for
 * inference) and the AppDO (so the UI can display the current model name)
 * read it from here.
 */

const WORKERS_AI_DEFAULT = "@cf/moonshotai/kimi-k2.6";
const OPENAI_FALLBACK    = "gpt-4o-mini";

interface ModelEnv {
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?:   string;
}

/** Returns the model id that Agent.onChatMessage will pick on the next turn. */
export function currentModelId(env: ModelEnv): string {
  if (env.OPENAI_API_KEY) return env.OPENAI_MODEL ?? OPENAI_FALLBACK;
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
