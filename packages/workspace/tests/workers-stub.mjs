/**
 * Stub for the `cloudflare:workers` builtin. We only need the named exports
 * that `@cloudflare/containers` / `@cloudflare/sandbox` pull out at module
 * load time \u2014 we don't actually instantiate any of these in tests.
 */

export class DurableObject {}
export class WorkerEntrypoint {}
export class WorkflowEntrypoint {}
export class RpcTarget {}
export const env = {};
