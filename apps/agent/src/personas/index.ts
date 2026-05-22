import type { Persona } from "./types.js";
import { zigPersona } from "./zig.js";
import { goPersona } from "./go.js";
import { cloudflareWorkerPersona } from "./cloudflare-worker/index.js";

export type { Persona, ToolName } from "./types.js";
export { COMMON_TOOLS } from "./types.js";
export { WorkerDeployer } from "./cloudflare-worker/deploy.js";
export type { DeployResult } from "./cloudflare-worker/deploy.js";
export { parseFetchCall, fetchAgainstWorker } from "./cloudflare-worker/fetch.js";
export type { FetchToolResult, ParsedFetch } from "./cloudflare-worker/fetch.js";

const all = [cloudflareWorkerPersona, goPersona, zigPersona];

const byId = new Map(all.map(p => [p.id, p]));

export const PERSONAS: readonly Persona[] = all;
export const DEFAULT_PERSONA: Persona = cloudflareWorkerPersona;

export function lookupPersona(id: string | undefined | null): Persona {
  if (!id) return DEFAULT_PERSONA;
  return byId.get(id) ?? DEFAULT_PERSONA;
}
