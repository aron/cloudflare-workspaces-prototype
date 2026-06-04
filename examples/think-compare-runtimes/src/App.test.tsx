// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { App } from "./App";

vi.mock("partysocket/react", () => ({
  usePartySocket: vi.fn(),
}));

describe("App", () => {
  afterEach(() => {
    cleanup();
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

  test("renders per-runtime terminal status and capacity errors", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json(
        {
          runId: "run-789",
          socketPath: "/parties/compare-run/run-789",
          events: [
            {
              id: "run-789:0",
              runId: "run-789",
              sequence: 0,
              runtime: "both",
              kind: "run_started",
              title: "Comparison run started",
              detail: "Both agents are starting.",
              timestamp: "2026-06-04T00:00:00.000Z",
            },
            {
              id: "run-789:1",
              runId: "run-789",
              sequence: 1,
              runtime: "workspace",
              kind: "runtime_started",
              title: "Workspace runtime started",
              detail: "Workspace Think agent is running.",
              timestamp: "2026-06-04T00:00:01.000Z",
            },
            {
              id: "run-789:2",
              runId: "run-789",
              sequence: 2,
              runtime: "workspace",
              kind: "runtime_completed",
              title: "Workspace runtime completed",
              detail: "Workspace Think agent completed.",
              timestamp: "2026-06-04T00:00:06.000Z",
            },
            {
              id: "run-789:3",
              runId: "run-789",
              sequence: 3,
              runtime: "sandbox",
              kind: "runtime_started",
              title: "Sandbox runtime started",
              detail: "Sandbox Think agent is running.",
              timestamp: "2026-06-04T00:00:02.000Z",
            },
            {
              id: "run-789:4",
              runId: "run-789",
              sequence: 4,
              runtime: "sandbox",
              kind: "runtime_failed",
              title: "Sandbox runtime failed",
              detail: "3040: Capacity temporarily exceeded, please try again.",
              timestamp: "2026-06-04T00:00:08.500Z",
            },
            {
              id: "run-789:5",
              runId: "run-789",
              sequence: 5,
              runtime: "both",
              kind: "run_completed",
              title: "Comparison run complete",
              detail: "Workspace completed; Sandbox failed.",
              timestamp: "2026-06-04T00:00:08.500Z",
            },
          ],
        },
        { status: 201 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Start comparison" }));

    const workspacePanel = await screen.findByLabelText("Workspace timeline");
    const sandboxPanel = screen.getByLabelText("Sandbox timeline");

    expect(screen.getAllByText("failed").length).toBeGreaterThan(0);
    expect(screen.getByText("8.5s elapsed")).toBeTruthy();
    expect(within(workspacePanel).getByText("completed")).toBeTruthy();
    expect(within(workspacePanel).getByText("5.0s")).toBeTruthy();
    expect(within(sandboxPanel).getByText("failed")).toBeTruthy();
    expect(within(sandboxPanel).getByText("6.5s")).toBeTruthy();
    expect(within(sandboxPanel).getByText("Upstream model capacity; retry later.")).toBeTruthy();
  });

  test("renders Think transcript and runtime trace lanes with structured details", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json(
        {
          runId: "run-456",
          socketPath: "/parties/compare-run/run-456",
          events: [
            {
              id: "run-456:0",
              runId: "run-456",
              sequence: 0,
              runtime: "workspace",
              kind: "agent_tool_call",
              title: "Think requested exec",
              detail: JSON.stringify({ command: "npm test", cwd: "/workspace/repo" }),
              timestamp: "1970-01-01T00:00:00.000Z",
            },
            {
              id: "run-456:1",
              runId: "run-456",
              sequence: 1,
              runtime: "workspace",
              kind: "tool_result",
              title: "exec complete",
              detail: "Exit 0; stdout 3 bytes; stderr 0 bytes.",
              timestamp: "1970-01-01T00:00:00.000Z",
            },
            {
              id: "run-456:2",
              runId: "run-456",
              sequence: 2,
              runtime: "sandbox",
              kind: "agent_tool_result",
              title: "Think exec result",
              detail: JSON.stringify({ exitCode: 0, stdout: "ok\n", stderr: "" }),
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

    const workspacePanel = await screen.findByLabelText("Workspace timeline");
    const sandboxPanel = screen.getByLabelText("Sandbox timeline");

    expect(within(workspacePanel).getByRole("heading", { name: "Think transcript" })).toBeTruthy();
    expect(within(workspacePanel).getByRole("heading", { name: "Runtime trace" })).toBeTruthy();
    expect(within(workspacePanel).getByText("Think requested exec")).toBeTruthy();
    expect(within(workspacePanel).getByText("exec complete")).toBeTruthy();
    expect(within(workspacePanel).getByText("command")).toBeTruthy();
    expect(within(workspacePanel).getByText("npm test")).toBeTruthy();
    expect(within(workspacePanel).getByText("cwd")).toBeTruthy();
    expect(within(workspacePanel).getByText("/workspace/repo")).toBeTruthy();
    expect(within(sandboxPanel).getByText("exitCode")).toBeTruthy();
    expect(within(sandboxPanel).getByText("stdout")).toBeTruthy();
    expect(within(sandboxPanel).getByText("ok")).toBeTruthy();
  });
});
