/**
 * Backend descriptions handed to `createAITools`' `exec` tool.
 *
 * The package builds the tool description (and the `backend` enum)
 * from this map, so the per-backend prose is the only thing this app
 * has to own. Shared by the parent Agent and its sub-agents so both
 * describe the same execution planes.
 *
 * `env.LOADER` is optional: the agent-suite vitest fixtures run
 * against a stripped wrangler config with no `worker_loaders`
 * binding, so the worker backend isn't constructed there and the
 * container takes the default slot.
 */

export type ExecBackend = "shell" | "container";

const SHELL_DESCRIPTION = [
  "just-bash in a Dynamic Worker. Cold-start instant, no container,",
  "no public network. Good for cat / grep / sed / awk / jq / head /",
  "tail / sort / find / file inspection and quick text",
  "transformations. Registers three built-in commands that forward to",
  "the host workspace, so network-bound work runs here even though",
  "the isolate has no public network: `git` (clone / status / diff /",
  "log / branch / commit, https:// URLs only), `assets publish <path>",
  "[<expiry>]` to share a workspace file as a time-limited public R2",
  "URL, and `artifact create <name>` / `artifact share <name>` to",
  "create a Cloudflare Artifacts git repo with a registered remote or",
  "mint a clone-ready read URL. Cannot run npm, node, bun, or any",
  "binary outside just-bash's built-in command set.",
].join(" ");

const CONTAINER_DESCRIPTION = [
  "Cloudflare Container running computerd. Full Linux userland with a",
  "Node 24 + Bun toolchain on $PATH (node, npm, bun, esbuild,",
  "wrangler) and public network. Cold start is much slower because",
  "the container has to boot through the warm pool; reach for it when",
  "the shell backend can't run the command - typically `bun install`,",
  "`bun test`, `tsc`, `wrangler`, or anything else that needs a real",
  "Linux binary. For git itself, prefer the shell backend.",
].join(" ");

/**
 * The backends the workspace was constructed with, in the shape
 * `createAITools({ shell: { backends } })` expects. Keyed the same as
 * the backend ids passed to `new Workspace({ backends })`.
 */
export function execBackends(env: Env): Record<string, { description: string }> {
  return {
    ...(env.LOADER ? { shell: { description: SHELL_DESCRIPTION } } : {}),
    container: { description: CONTAINER_DESCRIPTION },
  };
}

/** The backend an `exec` call without an explicit `backend` runs on. */
export function defaultExecBackend(env: Env): ExecBackend {
  return env.LOADER ? "shell" : "container";
}
