// Minimal worker entry for the docker harness vitest project.
// The actual test logic lives in src/test-harness/*.test.ts;
// vitest-pool-workers requires a default export so the
// runtime has something to boot.
export default {
  async fetch(): Promise<Response> {
    return new Response("workspace harness", { status: 200 });
  },
};
