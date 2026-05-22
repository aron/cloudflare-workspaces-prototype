/**
 * Tiny client helper for talking to the WarmPool Durable Object.
 *
 * Mirrors the bridge's pool resolution pattern: every request configures
 * the pool with current vars (idempotent) and asks it to resolve the
 * caller's sandbox id into a container UUID. The UUID is what we then
 * pass to `getSandbox(env.Sandbox, ...)` — that way the pool's pre-
 * started container is the one we end up using.
 */

import type { WarmPool, WarmPoolConfig } from "./warm-pool.js";

interface PoolEnv {
  WarmPool: DurableObjectNamespace<WarmPool>;
  WARM_POOL_TARGET?:           string;
  WARM_POOL_REFRESH_INTERVAL?: string;
}

function readConfig(env: PoolEnv): Required<WarmPoolConfig> {
  return {
    warmTarget:      Number.parseInt(env.WARM_POOL_TARGET ?? "0", 10) || 0,
    refreshInterval: Number.parseInt(env.WARM_POOL_REFRESH_INTERVAL ?? "10000", 10) || 10_000,
  };
}

function poolStub(env: PoolEnv) {
  const id = env.WarmPool.idFromName("global-pool");
  return env.WarmPool.get(id);
}

/**
 * Resolve a session id to a container UUID. Pushes the latest config to
 * the pool every call so wrangler-var changes take effect on deploy.
 */
export async function resolveContainerId(env: PoolEnv, sessionId: string): Promise<string> {
  const stub = poolStub(env);
  await stub.configure(readConfig(env));
  return stub.getContainer(sessionId);
}

/** Prime the pool — kicks off its alarm loop. Called from `scheduled()`. */
export async function primePool(env: PoolEnv): Promise<void> {
  await poolStub(env).configure(readConfig(env));
}

/** Pool stats, for debug endpoints. */
export async function poolStats(env: PoolEnv) {
  return poolStub(env).getStats();
}
