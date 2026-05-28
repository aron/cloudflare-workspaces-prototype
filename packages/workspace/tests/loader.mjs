/**
 * Custom resolver hook that maps native-only / workerd-only specifiers to
 * empty stub modules so test files can load source modules that import
 * them without actually instantiating native or workerd code.
 *
 *   cloudflare:workers  — only exists inside workerd.
 *   fuse-native         — a native addon; optional dependency that may
 *                         not be installed in the test environment.
 */

const WORKERS_STUB = new URL("./workers-stub.mjs", import.meta.url).href;
const FUSE_STUB    = new URL("./fuse-native-stub.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "cloudflare:workers") {
    return { url: WORKERS_STUB, shortCircuit: true, format: "module" };
  }
  if (specifier === "fuse-native") {
    return { url: FUSE_STUB, shortCircuit: true, format: "module" };
  }
  return nextResolve(specifier, context);
}
