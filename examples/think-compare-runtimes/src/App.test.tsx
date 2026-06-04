// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { App } from "./App";

vi.mock("partysocket/react", () => ({
  usePartySocket: vi.fn(),
}));

describe("App", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("starts a comparison run from the UI", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json(
        {
          runId: "run-123",
          socketPath: "/parties/compare-run/run-123",
          events: [
            {
              id: "run-123:0",
              runId: "run-123",
              sequence: 0,
              runtime: "both",
              kind: "run_started",
              title: "Comparison run started",
              detail: "Both agents are starting.",
              timestamp: "1970-01-01T00:00:00.000Z",
            },
          ],
        },
        { status: 201 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Start comparison" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/runs", { method: "POST" }));
    expect(await screen.findByText("run-123")).toBeTruthy();
    expect(screen.getAllByText("Comparison run started")).toHaveLength(2);
  });
});
