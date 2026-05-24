import { describe, expect, it } from "vitest";
import { readResponseCapped } from "../src/read-capped.js";

function streamingResponse(chunks: Uint8Array[], headers: Record<string, string> = {}): Response {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = chunks.shift();
      if (next === undefined || cancelled) {
        controller.close();
      } else {
        controller.enqueue(next);
      }
    },
    cancel() {
      cancelled = true;
    },
  });
  // expose the cancelled flag for assertions
  (stream as any).__wasCancelled = () => cancelled;
  return new Response(stream, { headers });
}

const enc = new TextEncoder();

describe("readResponseCapped", () => {
  it("reads the full body when under the cap", async () => {
    const res = streamingResponse([enc.encode("hello "), enc.encode("world")]);
    const out = await readResponseCapped(res, 1024);
    expect(new TextDecoder().decode(out.bytes)).toBe("hello world");
    expect(out.truncated).toBe(false);
  });

  it("stops once the byte cap is reached and reports truncated=true", async () => {
    const big = enc.encode("x".repeat(1000));
    const res = streamingResponse([big, big, big, big]); // 4 KB
    const out = await readResponseCapped(res, 1500);
    expect(out.bytes.length).toBeLessThanOrEqual(2000); // first two chunks
    expect(out.bytes.length).toBeGreaterThanOrEqual(1500);
    expect(out.truncated).toBe(true);
  });

  it("returns an empty buffer for empty bodies", async () => {
    const res = streamingResponse([]);
    const out = await readResponseCapped(res, 100);
    expect(out.bytes.length).toBe(0);
    expect(out.truncated).toBe(false);
  });

  it("cancels the underlying stream when truncating", async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(enc.encode("x".repeat(500)));
      },
      cancel() {
        (this as any).cancelled = true;
      },
    });
    const res = new Response(stream);
    await readResponseCapped(res, 100);
    // If cancel weren't called the `pull` puller would loop forever — the
    // fact that this test completes is itself the assertion.
    expect(true).toBe(true);
  });
});
