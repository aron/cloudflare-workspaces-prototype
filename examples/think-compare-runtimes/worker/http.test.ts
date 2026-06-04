import { describe, expect, test } from "vitest";
import { handleApiRequest } from "./http";

describe("handleApiRequest", () => {
  test("starts a run from POST /api/runs", async () => {
    const response = await handleApiRequest(
      new Request("https://example.com/api/runs", { method: "POST" }),
      () => "run-abc",
    );

    expect(response).not.toBeNull();
    expect(response?.status).toBe(201);
    await expect(response?.json()).resolves.toMatchObject({
      runId: "run-abc",
      socketPath: "/parties/compare-run/run-abc",
    });
  });

  test("returns null for non-API routes", async () => {
    const response = await handleApiRequest(
      new Request("https://example.com/parties/compare-run/run-abc"),
    );

    expect(response).toBeNull();
  });
});
