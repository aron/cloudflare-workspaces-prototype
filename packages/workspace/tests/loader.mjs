/**
 * Custom resolver hook that maps `cloudflare:workers` (a builtin only
 * available in workerd) to an empty stub module so test files can load
 * code that re-exports DurableObject etc. without actually instantiating it.
 */

const STUB_URL = new URL("./workers-stub.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "cloudflare:workers") {
    return { url: STUB_URL, shortCircuit: true, format: "module" };
  }
  return nextResolve(specifier, context);
}
