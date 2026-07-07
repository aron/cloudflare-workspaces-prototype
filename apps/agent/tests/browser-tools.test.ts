/**
 * Unit tests for the agent-side browser-tools wiring: which tools are present
 * given a browser binding (or not), the saveImage → workspace path, and the
 * file-URL builder.
 */
import { describe, it, expect, vi } from "vitest";
import {
  buildBrowserTools,
  fileUrlFor,
  SCREENSHOT_DIR,
  type ScreenshotFs,
} from "../src/browser-tools.js";

function fakeBrowser() {
  return { quickAction: vi.fn().mockResolvedValue(new Response("{}")) };
}

describe("fileUrlFor", () => {
  it("builds a threads/files URL under the origin", () => {
    expect(fileUrlFor("https://app.example", "t1", "/workspace/a.png")).toBe(
      "https://app.example/api/threads/t1/files/workspace/a.png",
    );
  });
  it("trims trailing slashes on the origin", () => {
    expect(fileUrlFor("https://app.example/", "t1", "/workspace/a.png")).toBe(
      "https://app.example/api/threads/t1/files/workspace/a.png",
    );
  });
  it("returns undefined without a baseUrl", () => {
    expect(fileUrlFor("", "t1", "/workspace/a.png")).toBeUndefined();
    expect(fileUrlFor(undefined, "t1", "/workspace/a.png")).toBeUndefined();
  });
});

describe("buildBrowserTools", () => {
  const getFs = async (): Promise<ScreenshotFs> => ({
    writeFile: async () => {},
    mkdir: async () => {},
  });

  it("always exposes webfetch", () => {
    const noBrowser = buildBrowserTools({ getFs, vision: false, threadId: "t1" });
    expect(Object.keys(noBrowser)).toEqual(["webfetch"]);
  });

  it("adds screenshot only when a browser binding is present", () => {
    const withBrowser = buildBrowserTools({
      browser: fakeBrowser(),
      getFs,
      vision: true,
      threadId: "t1",
    });
    expect(Object.keys(withBrowser).sort()).toEqual(["screenshot", "webfetch"]);
  });

  it("saveImage writes under the screenshot dir and returns a URL", async () => {
    const writes: Array<{ path: string; bytes: Uint8Array }> = [];
    const fs: ScreenshotFs = {
      writeFile: async (path, bytes) => {
        writes.push({ path, bytes });
      },
      mkdir: vi.fn(async () => {}),
    };
    const browser = fakeBrowser();
    // Return raw PNG bytes so the screenshot tool's execute saves them.
    browser.quickAction.mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
    );
    const tools = buildBrowserTools({
      browser,
      getFs: async () => fs,
      vision: true,
      baseUrl: "https://app.example",
      threadId: "thread-9",
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const shot = tools.screenshot as any;
    const out = await shot.execute(
      { url: "https://example.com" },
      { toolCallId: "t", messages: [] },
    );

    expect(writes).toHaveLength(1);
    expect(writes[0].path.startsWith(`${SCREENSHOT_DIR}/`)).toBe(true);
    expect(writes[0].path.endsWith(".png")).toBe(true);
    expect(Array.from(writes[0].bytes)).toEqual([1, 2, 3]);
    expect(out.path).toBe(writes[0].path);
    expect(out.fileUrl).toBe(
      `https://app.example/api/threads/thread-9/files${writes[0].path}`,
    );
    expect(out.mediaType).toBe("image/png");
  });
});
